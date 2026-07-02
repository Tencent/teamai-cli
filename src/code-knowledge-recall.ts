/**
 * Graph-aware codebase knowledge recall (BM25 + graph-boost).
 *
 * Recall algorithm based on Team Wiki's wiki-query design by @lurkacai.
 * Implements scored mode with graph neighbor boosting.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { GraphIndex } from './wiki-engine/core/graph-index.schema.js';
import { tokenize, tokenCount, MAX_TOKENIZE_CHARS } from './utils/tokenizer.js';

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

function countOccurrences(text: string, token: string): number {
  let count = 0;
  let idx = 0;
  const lower = (text.length > MAX_TOKENIZE_CHARS ? text.slice(0, MAX_TOKENIZE_CHARS) : text).toLowerCase();
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
    totalLength += page.tokenCount;
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

  let projectDirs: string[];
  try {
    const entries = await readdir(evidenceDir, { withFileTypes: true });
    projectDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return pages;
  }

  for (const project of projectDirs) {
    const projectDir = path.join(evidenceDir, project);
    await loadPagesRecursive(projectDir, `evidence/code/${project}`, pages);
  }

  return pages;
}

async function loadPagesRecursive(dir: string, relativePath: string, pages: PageDoc[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await loadPagesRecursive(fullPath, `${relativePath}/${entry.name}`, pages);
    } else if (entry.name.endsWith('.md')) {
      try {
        const content = await readFile(fullPath, 'utf-8');
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : entry.name.replace('.md', '');
        pages.push({
          path: `${relativePath}/${entry.name}`,
          title,
          content,
          tokens: tokenize(content),
          tokenCount: tokenCount(content),
        });
      } catch {
        continue;
      }
    }
  }
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

  const TOKEN_BUDGET: Record<string, number> = { route: 1500, context: 5000, lookup: 20000 };
  const budget = TOKEN_BUDGET[depth] ?? 5000;
  const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

  const results: CodeKnowledgeResult[] = [];
  let tokenUsed = 0;

  for (const { page, score } of scored) {
    if (results.length >= limit) break;

    let snippet: string;
    if (depth === 'route') {
      snippet = `${page.title} (${page.path})`;
    } else if (depth === 'lookup') {
      const maxChars = Math.floor(budget * 3.5 * 0.7 / Math.max(limit, 1));
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
