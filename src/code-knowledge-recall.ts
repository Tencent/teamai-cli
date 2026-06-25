/**
 * Graph-aware codebase knowledge recall (BM25 + graph-boost).
 *
 * Recall algorithm based on Team Wiki's wiki-query design by @lurkacai.
 * Implements scored mode with graph neighbor boosting.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { CodeGraphIndex } from './wiki-engine/adapters/index.js';

export interface CodeKnowledgeResult {
  page: string;
  title: string;
  score: number;
  snippet: string;
  kind: 'codebase';
}

interface CorpusStats {
  totalDocs: number;
  avgDocLength: number;
  df: Map<string, number>;
}

interface PageDoc {
  path: string;
  title: string;
  content: string;
  tokens: string[];
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const TITLE_BOOST = 3.0;
const RELATION_WEIGHT: Record<string, number> = { imports: 3, mentions: 1, contains: 1 };
const ENTRY_NODE_BOOST = 8;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9一-鿿]+/).filter((w) => w.length >= 2);
  for (const w of words) {
    tokens.push(w);
  }
  return [...new Set(tokens)];
}

function countOccurrences(text: string, token: string): number {
  let count = 0;
  let idx = 0;
  const lower = text.toLowerCase();
  while (true) {
    idx = lower.indexOf(token, idx);
    if (idx === -1) break;
    count++;
    idx += token.length;
  }
  return count;
}

function buildCorpusStats(pages: PageDoc[]): CorpusStats {
  const df = new Map<string, number>();
  let totalLength = 0;

  for (const page of pages) {
    totalLength += page.tokens.length;
    const seen = new Set<string>();
    for (const token of page.tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
  }

  return {
    totalDocs: pages.length,
    avgDocLength: pages.length > 0 ? totalLength / pages.length : 1,
    df,
  };
}

function scoreBM25(page: PageDoc, queryTokens: string[], stats: CorpusStats): number {
  let score = 0;
  const dl = page.tokens.length;
  const { totalDocs, avgDocLength, df } = stats;

  for (const token of queryTokens) {
    const docFreq = df.get(token) ?? 0;
    const idf = Math.log((totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
    const tf = countOccurrences(page.content, token);
    const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgDocLength));
    const titleHit = page.title.toLowerCase().includes(token) ? TITLE_BOOST : 0;
    score += idf * (tfNorm + titleHit);
  }

  return score;
}

function findEntryNodes(queryTokens: string[], graph: CodeGraphIndex): Set<string> {
  const entries = new Set<string>();
  for (const node of graph.nodes) {
    const text = `${node.id} ${node.label}`.toLowerCase();
    for (const token of queryTokens) {
      if (token.length > 1 && text.includes(token)) {
        entries.add(node.file);
        break;
      }
    }
  }
  return entries;
}

function computeGraphBoost(pagePath: string, entryNodes: Set<string>, graph: CodeGraphIndex): number {
  if (entryNodes.has(pagePath)) return ENTRY_NODE_BOOST;

  let maxBoost = 0;
  for (const edge of graph.edges) {
    let isNeighbor = false;
    if (edge.from === pagePath && entryNodes.has(edge.to)) isNeighbor = true;
    if (edge.to === pagePath && entryNodes.has(edge.from)) isNeighbor = true;

    if (isNeighbor) {
      const relWeight = RELATION_WEIGHT[edge.relation] ?? 1;
      const boost = relWeight * 0.8;
      if (boost > maxBoost) maxBoost = boost;
    }
  }
  return maxBoost;
}

function extractSnippet(content: string, queryTokens: string[], maxLen: number = 300): string {
  const lower = content.toLowerCase();
  let bestIdx = 0;
  for (const token of queryTokens) {
    const idx = lower.indexOf(token);
    if (idx >= 0) {
      bestIdx = idx;
      break;
    }
  }
  const start = Math.max(0, bestIdx - 50);
  const end = Math.min(content.length, start + maxLen);
  let snippet = content.slice(start, end).replace(/\n+/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet += '...';
  return snippet;
}

async function loadWikiPages(wikiRoot: string): Promise<PageDoc[]> {
  const evidenceDir = path.join(wikiRoot, 'evidence', 'code');
  const pages: PageDoc[] = [];

  let projects: string[];
  try {
    projects = await readdir(evidenceDir);
  } catch {
    return pages;
  }

  for (const project of projects) {
    const projectDir = path.join(evidenceDir, project);
    let files: string[];
    try {
      files = await readdir(projectDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const filePath = path.join(projectDir, file);
        const content = await readFile(filePath, 'utf-8');
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : file.replace('.md', '');
        pages.push({
          path: `evidence/code/${project}/${file}`,
          title,
          content,
          tokens: tokenize(content),
        });
      } catch {
        continue;
      }
    }
  }

  return pages;
}

async function loadGraphIndex(wikiRoot: string): Promise<CodeGraphIndex | null> {
  const graphPath = path.join(wikiRoot, '.indices', 'graph-index.json');
  try {
    const raw = await readFile(graphPath, 'utf-8');
    return JSON.parse(raw) as CodeGraphIndex;
  } catch {
    return null;
  }
}

export interface QueryCodeKnowledgeOptions {
  wikiRoot: string;
  limit?: number;
  depth?: 'route' | 'context' | 'lookup';
}

export async function queryCodeKnowledge(
  query: string,
  options: QueryCodeKnowledgeOptions,
): Promise<CodeKnowledgeResult[]> {
  const { wikiRoot, limit = 5, depth = 'context' } = options;

  const pages = await loadWikiPages(wikiRoot);
  if (pages.length === 0) return [];

  const graph = await loadGraphIndex(wikiRoot);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const stats = buildCorpusStats(pages);
  const entryNodes = graph ? findEntryNodes(queryTokens, graph) : new Set<string>();

  const scored: Array<{ page: PageDoc; score: number }> = [];
  for (const page of pages) {
    let score = scoreBM25(page, queryTokens, stats);
    if (graph) {
      const pageFile = page.path.replace(/^evidence\/code\/[^/]+\//, '').replace('.md', '');
      score += computeGraphBoost(pageFile, entryNodes, graph);
    }
    if (score > 0) {
      scored.push({ page, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const TOKEN_BUDGET: Record<string, number> = { route: 500, context: 5000, lookup: 3000 };
  const budget = TOKEN_BUDGET[depth] ?? 5000;
  const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

  const results: CodeKnowledgeResult[] = [];
  let tokenUsed = 0;

  for (const { page, score } of scored) {
    if (results.length >= limit) break;

    let snippet: string;
    if (depth === 'route') {
      snippet = page.title;
    } else if (depth === 'lookup' && results.length === 0) {
      const maxChars = Math.floor(budget * 3.5 * 0.7);
      snippet = page.content.slice(0, maxChars);
    } else {
      snippet = extractSnippet(page.content, queryTokens);
    }

    const cost = estimateTokens(page.title + ' ' + snippet);
    if (tokenUsed + cost > budget && results.length > 0) break;
    tokenUsed += cost;

    results.push({
      page: page.path,
      title: page.title,
      score,
      snippet,
      kind: 'codebase',
    });
  }

  return results;
}
