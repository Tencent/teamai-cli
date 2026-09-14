/**
 * 会话检索引擎 — BM25 + 时间衰减。
 *
 * 对已迁移的会话建立 BM25 索引，支持关键词检索。
 * 标题加权 3x，时间衰减半衰期 30 天（影响 30% 权重）。
 *
 * Ported from sessionflow/core/search.py
 */

import type { Session, Message } from './ir.js';

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

export interface SearchHit {
  sessionName: string;
  author: string;
  platform: string;
  title: string;
  cwd: string;
  score: number;
  snippet: string;
  messageCount: number;
  createdAt: string;
  matchedMessages: Array<{
    role: string;
    snippet: string;
    timestamp?: string;
  }>;
}

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let currentWord = '';

  for (const ch of lower) {
    if (/[a-z0-9_]/.test(ch)) {
      currentWord += ch;
    } else {
      if (currentWord) {
        tokens.push(currentWord);
        currentWord = '';
      }
      // 中文字符单独成 token
      if (/[\u4e00-\u9fff]/.test(ch)) {
        tokens.push(ch);
      }
    }
  }
  if (currentWord) tokens.push(currentWord);
  return tokens;
}

function extractTextFromMessage(msg: Message): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'thinking') {
      parts.push(block.text);
    } else if (block.type === 'tool_call') {
      parts.push(block.toolName);
      parts.push(Object.values(block.arguments).map(String).join(' '));
    }
  }
  return parts.join(' ');
}

function makeSnippet(text: string, query: string, maxLen = 200): string {
  if (!text) return '';
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  let idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) {
    for (const token of tokenize(query)) {
      idx = lowerText.indexOf(token);
      if (idx !== -1) break;
    }
  }
  if (idx === -1) {
    return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '');
  }

  const start = Math.max(0, idx - Math.floor(maxLen / 3));
  const end = Math.min(text.length, start + maxLen);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

// ---------------------------------------------------------------------------
// 时间衰减
// ---------------------------------------------------------------------------

function timeDecay(createdAt: string, halfLifeDays = 30): number {
  const dt = new Date(createdAt);
  if (isNaN(dt.getTime())) return 0.5;
  const now = Date.now();
  const daysAgo = (now - dt.getTime()) / 86_400_000;
  if (daysAgo < 0) return 1.0;
  return Math.pow(0.5, daysAgo / halfLifeDays);
}

// ---------------------------------------------------------------------------
// BM25 Okapi（自行实现，零依赖）
// ---------------------------------------------------------------------------

class BM25Okapi {
  private corpus: string[][];
  private k1: number;
  private b: number;
  private avgDl: number;
  private idf: Map<string, number>;
  private docFreq: Map<string, number>;
  private docLen: number[];

  constructor(corpus: string[][], k1 = 1.5, b = 0.75) {
    this.corpus = corpus;
    this.k1 = k1;
    this.b = b;
    this.docLen = corpus.map((doc) => doc.length);
    this.avgDl = this.docLen.length > 0
      ? this.docLen.reduce((s, n) => s + n, 0) / this.docLen.length
      : 0;

    // 计算 document frequency
    this.docFreq = new Map();
    for (const doc of corpus) {
      const seen = new Set(doc);
      for (const term of seen) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }

    // 计算 IDF (Okapi BM25 variant)
    const N = corpus.length;
    this.idf = new Map();
    for (const [term, df] of this.docFreq) {
      this.idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }
  }

  getScores(queryTokens: string[]): number[] {
    const scores = new Array(this.corpus.length).fill(0);

    for (let i = 0; i < this.corpus.length; i++) {
      const doc = this.corpus[i];
      const docTermFreq = new Map<string, number>();
      for (const term of doc) {
        docTermFreq.set(term, (docTermFreq.get(term) ?? 0) + 1);
      }

      const dl = this.docLen[i] || 1;
      const normFactor = 1 - this.b + this.b * (dl / (this.avgDl || 1));

      for (const term of queryTokens) {
        const tf = docTermFreq.get(term) ?? 0;
        if (tf === 0) continue;
        const idf = this.idf.get(term) ?? 0;
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * normFactor;
        scores[i] += idf * (numerator / denominator);
      }
    }

    return scores;
  }
}

// ---------------------------------------------------------------------------
// 搜索引擎
// ---------------------------------------------------------------------------

export interface LoadedSession {
  sessionName: string;
  author: string;
  session: Session;
}

export class SessionSearchEngine {
  /**
   * 搜索已加载的会话列表。
   *
   * @param sessions 已加载的会话列表（sessionName + author + Session）
   * @param query 搜索关键词
   * @param options 搜索选项
   */
  async search(
    sessions: LoadedSession[],
    query: string,
    options: { limit?: number; enableDecay?: boolean } = {},
  ): Promise<SearchHit[]> {
    const { limit = 20, enableDecay = true } = options;

    if (!query.trim()) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    if (sessions.length === 0) return [];

    // 构建文档
    const docs = sessions.map((s) => {
      const msgTexts = s.session.messages.map(extractTextFromMessage);
      const fullText = msgTexts.join(' ');
      let tokens = tokenize(fullText);
      // 标题加权 3x
      const titleTokens = tokenize(s.session.title);
      tokens = [...titleTokens, ...titleTokens, ...titleTokens, ...tokens];
      return { meta: s, tokens, fullText, msgTexts };
    });

    // BM25 检索
    const corpus = docs.map((d) => d.tokens);
    const bm25 = new BM25Okapi(corpus);
    const scores = bm25.getScores(queryTokens);

    // 构建结果
    const results: SearchHit[] = [];
    for (let i = 0; i < docs.length; i++) {
      const rawScore = scores[i];
      if (rawScore <= 0) continue;

      const doc = docs[i];
      const decay = enableDecay ? timeDecay(doc.meta.session.createdAt) : 1.0;
      const finalScore = rawScore * (0.7 + 0.3 * decay);

      // 找到匹配的消息
      const lowerQuery = query.toLowerCase();
      const matched: SearchHit['matchedMessages'] = [];
      for (let j = 0; j < doc.msgTexts.length; j++) {
        if (doc.msgTexts[j].toLowerCase().includes(lowerQuery)) {
          const msg = doc.meta.session.messages[j];
          matched.push({
            role: msg.role,
            snippet: makeSnippet(doc.msgTexts[j], query),
            timestamp: msg.timestamp,
          });
          if (matched.length >= 3) break;
        }
      }

      results.push({
        sessionName: doc.meta.sessionName,
        author: doc.meta.author,
        platform: doc.meta.session.platform,
        title: doc.meta.session.title,
        cwd: doc.meta.session.cwd,
        score: finalScore,
        snippet: makeSnippet(doc.fullText, query),
        messageCount: doc.meta.session.messages.length,
        createdAt: doc.meta.session.createdAt,
        matchedMessages: matched,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
