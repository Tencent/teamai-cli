/**
 * Session search engine — BM25 + time decay.
 *
 * Builds a BM25 index over migrated sessions and supports keyword search.
 * Title, conversation and tool output are separate fields weighted 3x, 1x and 0.1x;
 * time decay has a 30-day half-life (30% of the weight).
 *
 * Ported from sessionflow/core/search.py
 */

import { AgentSession } from './agent-session.js';
import type { Session } from '@teamai/tool-core/sessions/ir';

// ---------------------------------------------------------------------------
// Data structures
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
// Tokenization
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

      // Each CJK character is its own token
      if (/[\u4e00-\u9fff]/.test(ch)) {
        tokens.push(ch);
      }
    }
  }

  if (currentWord) tokens.push(currentWord);

  return tokens;
}

function makeSnippet(rawText: string, query: string, maxLen = 200): string {
  if (!rawText) return '';
  // One line: tool output is multi-line, and a snippet is printed in a list.
  const text = rawText.replace(/\s+/g, ' ');
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
// Time decay
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
// BM25 Okapi (hand-rolled, zero dependencies)
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

    // Compute document frequency
    this.docFreq = new Map();

    for (const doc of corpus) {
      const seen = new Set(doc);

      for (const term of seen) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }

    // Compute IDF (Okapi BM25 variant)
    const N = corpus.length;
    this.idf = new Map();

    for (const [term, df] of this.docFreq) {
      this.idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }
  }

  getScores(queryTokens: string[]): number[] {
    const scores = Array.from({ length: this.corpus.length }, () => 0);

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
// Search engine
// ---------------------------------------------------------------------------

export interface LoadedSession {
  sessionName: string;
  author: string;
  session: Session;
}

const TITLE_WEIGHT = 3;

// A dump repeating a term stays below one conversation mention up to ~8x average length; 0.3 fails the tests.
const TOOL_OUTPUT_WEIGHT = 0.1;

export class SessionSearchEngine {
  /**
   * Search the already-loaded session list.
   *
   * @param sessions Already-loaded sessions (sessionName + author + Session)
   * @param query Search keywords
   * @param options Search options
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

    // Build documents: one transcript entry per message, so a match cites its message. The transcript
    // truncates each tool result; search indexes the whole output, where a build log's error often comes last.
    const docs = sessions.map((s) => {
      const entries = AgentSession.transcript(s.session).map((entry, i) => ({
        ...entry,
        toolOutput: s.session.messages[i].content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : [])).join('\n'),
      }));

      const messageTexts = entries.map((e) => [e.text, e.toolOutput].filter(Boolean).join('\n'));

      return {
        meta: s,
        entries,
        messageTexts,
        fullText: messageTexts.join(' '),
        titleTokens: tokenize(s.session.title),
        bodyTokens: tokenize(entries.map((e) => e.text).join(' ')),
        toolOutputTokens: tokenize(entries.map((e) => e.toolOutput).join(' ')),
      };
    });

    // BM25 retrieval, one field each for the title, the conversation, and tool output. Tool output
    // is long and repetitive; inside one field with the conversation it would outweigh it.
    const scoresOf = (field: (d: (typeof docs)[number]) => string[]) =>
      new BM25Okapi(docs.map(field)).getScores(queryTokens);

    const titleScores = scoresOf((d) => d.titleTokens);
    const bodyScores = scoresOf((d) => d.bodyTokens);
    const toolOutputScores = scoresOf((d) => d.toolOutputTokens);

    const scores = docs.map(
      (_, i) => bodyScores[i] + TITLE_WEIGHT * titleScores[i] + TOOL_OUTPUT_WEIGHT * toolOutputScores[i],
    );

    // Build results
    const results: SearchHit[] = [];

    for (let i = 0; i < docs.length; i++) {
      const rawScore = scores[i];

      if (rawScore <= 0) continue;

      const doc = docs[i];
      const decay = enableDecay ? timeDecay(doc.meta.session.createdAt) : 1.0;
      const finalScore = rawScore * (0.7 + 0.3 * decay);

      // Find matching messages
      const lowerQuery = query.toLowerCase();
      const matched: SearchHit['matchedMessages'] = [];

      for (const [j, entry] of doc.entries.entries()) {
        if (doc.messageTexts[j].toLowerCase().includes(lowerQuery)) {
          matched.push({
            role: entry.role,
            snippet: makeSnippet(doc.messageTexts[j], query),
            timestamp: entry.timestamp,
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
