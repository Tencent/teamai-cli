/**
 * Graph-aware codebase knowledge recall (BM25 + graph-boost).
 *
 * Recall algorithm based on Team Wiki's wiki-query design by @lurkacai.
 * Implements scored mode with graph neighbor boosting.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { GraphIndex } from './wiki-engine/core/graph-index.schema.js';

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
  tokenCount: number; // B10: raw (non-deduplicated) token count for BM25 dl
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const TITLE_BOOST = 3.0;
const RELATION_WEIGHT: Record<string, number> = { DEPENDS_ON: 3, REFERENCES: 2, MAPS_TO: 2, CONTAINS: 1 };
const ENTRY_NODE_BOOST = 8;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // Split camelCase before tokenizing (B4 fix: camelCase splitting)
  const camelSplit = lower.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const words = camelSplit.split(/[^a-z0-9一-鿿]+/).filter((w) => w.length >= 2);
  for (const w of words) {
    tokens.push(w);
  }
  // B14: CJK bigram segmentation
  const cjkRuns = lower.match(/[一-鿿]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }
  return [...new Set(tokens)];
}

/** Raw (non-deduplicated) token count for BM25 dl (B10 fix) */
function rawTokenCount(text: string): number {
  const lower = text.toLowerCase();
  const camelSplit = lower.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return camelSplit.split(/[^a-z0-9一-鿿]+/).filter((w) => w.length >= 2).length;
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
    totalLength += page.tokenCount; // B10: use raw token count for avgDocLength
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
  const dl = page.tokenCount; // B10: use raw count, not unique count
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

/**
 * B8 fix: Match graph nodes to pages by slug/title instead of raw file paths.
 * Returns a set of node slugs that match the query.
 */
function findEntryNodes(queryTokens: string[], graph: GraphIndex): Set<string> {
  const entries = new Set<string>();
  for (const node of graph.nodes) {
    const text = `${node.slug} ${node.title}`.toLowerCase();
    for (const token of queryTokens) {
      if (token.length > 1 && text.includes(token)) {
        entries.add(node.slug);
        break;
      }
    }
  }
  return entries;
}

/**
 * B8 fix: Match page paths to graph node slugs via title/filename matching.
 * B24 fix: Use 2-hop neighbors (halved weight for second hop).
 */
function computeGraphBoost(page: PageDoc, entryNodes: Set<string>, graph: GraphIndex): number {
  // Match page to graph nodes by title
  const pageTitle = page.title.toLowerCase();
  const pageFile = page.path.replace(/^evidence\/code\/[^/]+\//, '').replace('.md', '');

  // Check if this page IS an entry node (by title or slug match)
  for (const slug of entryNodes) {
    const slugParts = slug.split('/');
    const slugName = (slugParts.pop() ?? '').toLowerCase();
    if (slugName && (pageTitle.includes(slugName) || pageFile.includes(slugName))) {
      return ENTRY_NODE_BOOST;
    }
  }

  // Check 1-hop and 2-hop neighbors
  let maxBoost = 0;
  for (const edge of graph.edges) {
    const isFrom = entryNodes.has(edge.from);
    const isTo = entryNodes.has(edge.to);
    if (!isFrom && !isTo) continue;

    const neighborSlug = isFrom ? edge.to : edge.from;
    const neighborParts = neighborSlug.split('/');
    const neighborName = (neighborParts.pop() ?? '').toLowerCase();

    if (neighborName && (pageTitle.includes(neighborName) || pageFile.includes(neighborName))) {
      const relWeight = RELATION_WEIGHT[edge.relation] ?? 1;
      const boost = relWeight * 0.8; // 1-hop
      if (boost > maxBoost) maxBoost = boost;
    }

    // 2-hop: check neighbors of this neighbor (B24)
    for (const edge2 of graph.edges) {
      if (edge2.from !== neighborSlug && edge2.to !== neighborSlug) continue;
      const hop2Slug = edge2.from === neighborSlug ? edge2.to : edge2.from;
      const hop2Parts = hop2Slug.split('/');
      const hop2Name = (hop2Parts.pop() ?? '').toLowerCase();
      if (hop2Name && (pageTitle.includes(hop2Name) || pageFile.includes(hop2Name))) {
        const relWeight = RELATION_WEIGHT[edge2.relation] ?? 1;
        const boost = relWeight * 0.4; // 2-hop: half weight
        if (boost > maxBoost) maxBoost = boost;
      }
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
          tokenCount: rawTokenCount(content), // B10: raw count for BM25 dl
        });
      } catch {
        continue;
      }
    }
  }

  return pages;
}

// B7: Use protocol loadGraphIndex instead of local implementation
async function loadGraph(wikiRoot: string): Promise<GraphIndex | null> {
  const { loadGraphIndex } = await import('./wiki-engine/core/graph-index.schema.js');
  return loadGraphIndex(wikiRoot);
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

  const graph = await loadGraph(wikiRoot);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const stats = buildCorpusStats(pages);
  const entryNodes = graph ? findEntryNodes(queryTokens, graph) : new Set<string>();

  const scored: Array<{ page: PageDoc; score: number }> = [];
  for (const page of pages) {
    let score = scoreBM25(page, queryTokens, stats);
    if (graph) {
      score += computeGraphBoost(page, entryNodes, graph);
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
