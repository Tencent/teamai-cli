import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  loadGraphIndex,
  saveGraphIndex,
  mergeGraphs,
  createGraphIndex,
  toPageSlug,
  validateGraph,
} from './core/graph-index.schema.js';
import type { GraphIndex, GraphNode, GraphEdge, GraphEdgeSource, RelationType } from './core/graph-index.schema.js';
import type { WikiConfidence } from './core/wiki-protocol.js';
import { buildConfidence } from './reconciler-v2-types.js';
import type {
  ConfidenceFactor,
  ApiInterfaceMatch,
  RuleCodeMatch,
  ReconcileStaleWarning,
  ReconcileStats,
} from './reconciler-v2-types.js';

// ─── Public interfaces ───────────────────────────────────────────────────────

export interface ReconcileOptions {
  wikiRoot: string;
  dryRun?: boolean;
  productDirs?: string[];
  codeDirs?: string[];
}

export interface ReconcileGraphEdge {
  from: string;
  to: string;
  relation: 'MAPS_TO';
  term: string;
  confidence: WikiConfidence;
  confidenceScore?: number;
}

export interface ReconcileGap {
  kind: 'NO_CODE_MAPPING' | 'NO_PRODUCT_DOC' | 'API_DOC_NO_IMPL' | 'CONCEPT_NOT_IMPLEMENTED';
  message: string;
  sources: string[];
}

export interface ReconcileConflict {
  kind: 'STATE_MISMATCH' | 'COUNT_MISMATCH' | 'BEHAVIOR_MISMATCH';
  message: string;
  productRef: string;
  codeRef: string;
}

export interface ReconcileResult {
  mappings: number;
  gaps: ReconcileGap[];
  conflicts: ReconcileConflict[];
  graphEdges: ReconcileGraphEdge[];
  apiMatches: ApiInterfaceMatch[];
  ruleMatches: RuleCodeMatch[];
  staleWarnings: ReconcileStaleWarning[];
  stats: ReconcileStats;
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface PageRecord {
  path: string;
  title: string;
  text: string;
  category?: string;
  updated?: string;
}

const BRIDGE_EDGE_SOURCE = 'bridge-reconcile' as const;
const PRODUCT_PAGE_TYPE = 'source' as const;
const CODE_PAGE_TYPE = 'component' as const;
const PAGE_CONFIDENCE = 'EXTRACTED' as const;
const PRODUCT_PAGE_DOMAIN = 'product-knowledge';
const CODE_PAGE_DOMAIN = 'code-knowledge';
const REPAIRABLE_CODE_EDGE_SOURCES = new Set<GraphEdgeSource>(['code-ast', 'code-heuristic']);
const MISSING_PATH_ERROR_CODE = 'ENOENT';
const REPAIRABLE_VALIDATION_ISSUE_CODE = 'edge.missing_node';
const SELF_LOOP_VALIDATION_ISSUE_CODE = 'edge.self_loop';
// The extractor deliberately emits a file-level IMPLEMENTS self-loop when a
// class implements an interface defined in the same file (edges are
// file-to-file, not symbol-to-symbol). validateGraph flags every self-loop as
// an issue with no reference back to the edge, so this repeats its own
// from === to + source/relation check rather than broadening what validateGraph
// itself treats as fatal for every other caller.
function isExpectedSelfLoop(edge: GraphEdge): boolean {
  return edge.from === edge.to
    && edge.relation === ('IMPLEMENTS' satisfies RelationType)
    && !!edge.source && REPAIRABLE_CODE_EDGE_SOURCES.has(edge.source);
}

async function loadReconciliationBase(wikiRoot: string): Promise<GraphIndex> {
  const graphPath = path.join(wikiRoot, '.indices', 'graph-index.json');
  const graph = await loadGraphIndex(wikiRoot);
  if (!graph) {
    if (!(await exists(graphPath))) return createGraphIndex();
    throw new Error(`Cannot reconcile invalid graph index at ${graphPath}`);
  }
  const base = createGraphIndex(
    graph.nodes,
    graph.edges.filter(edge => edge.source !== BRIDGE_EDGE_SOURCE),
  );
  const hasUnexpectedSelfLoop = base.edges.some(edge => edge.from === edge.to && !isExpectedSelfLoop(edge));
  if (
    hasUnexpectedSelfLoop
    || validateGraph(base).issues.some(issue =>
      issue.code !== REPAIRABLE_VALIDATION_ISSUE_CODE && issue.code !== SELF_LOOP_VALIDATION_ISSUE_CODE,
    )
  ) {
    throw new Error(`Cannot reconcile invalid graph index at ${graphPath}`);
  }
  const nodeSlugs = new Set(base.nodes.map(node => node.slug));
  const endpointNodes: GraphNode[] = [];
  for (const edge of base.edges) {
    if (!edge.source || !REPAIRABLE_CODE_EDGE_SOURCES.has(edge.source)) continue;
    for (const slug of [edge.from, edge.to]) {
      if (nodeSlugs.has(slug)) continue;
      nodeSlugs.add(slug);
      endpointNodes.push({
        slug,
        type: CODE_PAGE_TYPE,
        confidence: PAGE_CONFIDENCE,
        title: path.basename(slug),
        domain: CODE_PAGE_DOMAIN,
        source: edge.source,
        // Both endpoints of a code-ast/code-heuristic edge are files inside
        // the SAME codebase that produced it (an intra-repo import graph), so
        // a placeholder minted here for a missing endpoint is unambiguously
        // that codebase's too (#912 review round 11 P1): without this, a
        // withheld codebase's own tagged edges got removed from recall but
        // these origin-less placeholder nodes stayed behind and searchable.
        origin: edge.origin,
      });
    }
  }
  const repaired = mergeGraphs(base, createGraphIndex(endpointNodes));
  if (
    validateGraph(repaired).issues.some(issue => issue.code !== SELF_LOOP_VALIDATION_ISSUE_CODE)
  ) {
    throw new Error(`Cannot reconcile invalid graph index at ${graphPath}`);
  }
  return repaired;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === MISSING_PATH_ERROR_CODE) return false;
    throw error;
  }
}

async function readPages(dirPath: string): Promise<PageRecord[]> {
  if (!(await exists(dirPath))) return [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  const pages: PageRecord[] = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      pages.push(...await readPages(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const text = await readFile(full, 'utf8');
      const headingMatch = text.match(/^#\s+(.+)/m);
      const title = headingMatch ? headingMatch[1].trim() : entry.name.replace(/\.md$/, '');
      const updatedMatch = text.match(/updated[:\s]+(\d{4}-\d{2}-\d{2})/i);
      pages.push({
        path: full,
        title,
        text,
        updated: updatedMatch?.[1],
      });
    }
  }
  return pages;
}

function keyTerms(page: PageRecord): string[] {
  const terms = new Set<string>();
  // PascalCase identifiers
  for (const m of page.text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
    terms.add(m[1]);
  }
  // backtick tokens
  for (const m of page.text.matchAll(/`([^`]+)`/g)) {
    terms.add(m[1].trim());
  }
  // CJK words (2-6 chars)
  for (const m of page.text.matchAll(/[一-鿿]{2,6}/g)) {
    terms.add(m[0]);
  }
  return [...terms];
}

function extractApiEndpoints(text: string): string[] {
  const endpoints: string[] = [];
  for (const m of text.matchAll(/\b(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)/g)) {
    endpoints.push(`${m[1]} ${m[2]}`);
  }
  return endpoints;
}

function extractConcepts(text: string): string[] {
  const concepts = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
    concepts.add(m[1]);
  }
  return [...concepts];
}

function detectConflicts(product: PageRecord, code: PageRecord): ReconcileConflict[] {
  const conflicts: ReconcileConflict[] = [];

  // COUNT_MISMATCH: "N states" / "N 个状态"
  const countProd = product.text.match(/(\d+)\s*(?:states?|个状态)/i);
  const countCode = code.text.match(/(\d+)\s*(?:states?|个状态)/i);
  if (countProd && countCode && countProd[1] !== countCode[1]) {
    conflicts.push({
      kind: 'COUNT_MISMATCH',
      message: `State count mismatch: product says ${countProd[1]}, code says ${countCode[1]}`,
      productRef: product.path,
      codeRef: code.path,
    });
  }

  // STATE_MISMATCH: enum-like "A|B|C" patterns
  const enumProd = product.text.match(/`([A-Z_]+(?:\|[A-Z_]+){1,})`/);
  const enumCode = code.text.match(/`([A-Z_]+(?:\|[A-Z_]+){1,})`/);
  if (enumProd && enumCode && enumProd[1] !== enumCode[1]) {
    conflicts.push({
      kind: 'STATE_MISMATCH',
      message: `Enum mismatch: product "${enumProd[1]}" vs code "${enumCode[1]}"`,
      productRef: product.path,
      codeRef: code.path,
    });
  }

  // BEHAVIOR_MISMATCH: opposing keywords
  const OPPOSING_PAIRS: [RegExp, RegExp][] = [
    [/\bsync(?:hronous)?\b/i, /\basync(?:hronous)?\b/i],
    [/\bblocking\b/i, /\bnon-blocking\b/i],
  ];
  for (const [patA, patB] of OPPOSING_PAIRS) {
    const prodHasA = patA.test(product.text);
    const prodHasB = patB.test(product.text);
    const codeHasA = patA.test(code.text);
    const codeHasB = patB.test(code.text);
    if ((prodHasA && codeHasB && !codeHasA) || (prodHasB && codeHasA && !codeHasB)) {
      conflicts.push({
        kind: 'BEHAVIOR_MISMATCH',
        message: `Behavior keyword mismatch between product doc and code page`,
        productRef: product.path,
        codeRef: code.path,
      });
    }
  }

  return conflicts;
}

// ─── Main function ───────────────────────────────────────────────────────────

export async function reconcileKnowledge(options: ReconcileOptions): Promise<ReconcileResult> {
  const startMs = Date.now();
  const { wikiRoot, dryRun = false } = options;
  const productDirNames = options.productDirs ?? ['product', 'docs'];
  const codeDirNames = options.codeDirs ?? ['evidence/code'];

  for (const dir of [...productDirNames, ...codeDirNames]) {
    if (dir.includes('..') || path.isAbsolute(dir)) {
      throw new Error(`Unsafe directory path rejected: ${dir}`);
    }
  }

  // Read all pages
  const productPages: PageRecord[] = [];
  for (const dir of productDirNames) {
    productPages.push(...await readPages(path.join(wikiRoot, dir)));
  }
  const codePages: PageRecord[] = [];
  for (const dir of codeDirNames) {
    codePages.push(...await readPages(path.join(wikiRoot, dir)));
  }

  const graphEdges: ReconcileGraphEdge[] = [];
  const gaps: ReconcileGap[] = [];
  const conflicts: ReconcileConflict[] = [];
  const apiMatches: ApiInterfaceMatch[] = [];
  const ruleMatches: RuleCodeMatch[] = [];
  const staleWarnings: ReconcileStaleWarning[] = [];

  // Phase 1 — product → code term matching
  const mappedCodePaths = new Set<string>();
  const mappedProductPaths = new Set<string>();

  for (const productPage of productPages) {
    const terms = keyTerms(productPage);
    let matched = false;
    for (const codePage of codePages) {
      const matchedTerms = terms.filter(t => codePage.text.includes(t));
      if (matchedTerms.length === 0) continue;

      matched = true;
      mappedCodePaths.add(codePage.path);
      mappedProductPaths.add(productPage.path);

      for (const term of matchedTerms) {
        const nearTitle = codePage.title.includes(term);
        const factors: ConfidenceFactor[] = [
          { name: 'direct_match', weight: 0.9 },
          ...(nearTitle ? [{ name: 'title_proximity', weight: 0.1 }] : []),
        ];
        const nc = buildConfidence(factors);
        graphEdges.push({
          from: toPageSlug(path.relative(wikiRoot, productPage.path)),
          to: toPageSlug(path.relative(wikiRoot, codePage.path)),
          relation: 'MAPS_TO',
          term,
          confidence: nc.label,
          confidenceScore: nc.score,
        });
      }

      // Phase 5 — conflict detection for matched pairs
      conflicts.push(...detectConflicts(productPage, codePage));
    }

    // Phase 4 — concepts not implemented
    if (!matched) {
      const concepts = extractConcepts(productPage.text);
      const unimplemented = concepts.filter(
        c => !codePages.some(cp => cp.text.includes(c))
      );
      for (const concept of unimplemented) {
        gaps.push({
          kind: 'CONCEPT_NOT_IMPLEMENTED',
          message: `Concept "${concept}" from product doc not found in any code page`,
          sources: [productPage.path],
        });
      }
    }

    // Phase 3 — API endpoints with doc but no impl
    const endpoints = extractApiEndpoints(productPage.text);
    for (const endpoint of endpoints) {
      const pathPart = endpoint.split(' ')[1];
      const hasImpl = codePages.some(cp => cp.text.includes(pathPart));
      if (!hasImpl) {
        gaps.push({
          kind: 'API_DOC_NO_IMPL',
          message: `API endpoint "${endpoint}" documented but no code page references it`,
          sources: [productPage.path],
        });
      }
    }
  }

  // Phase 2 — code pages with no product doc
  for (const cp of codePages) {
    if (!mappedCodePaths.has(cp.path)) {
      gaps.push({ kind: 'NO_PRODUCT_DOC', message: `Code page "${cp.title}" has no matching product documentation`, sources: [cp.path] });
    }
  }

  // Phase 6: graphEdges already populated in Phase 1

  // Phase 7 — API↔Interface matching (path + method dual factor)
  for (const productPage of productPages) {
    const endpoints = extractApiEndpoints(productPage.text);
    for (const endpoint of endpoints) {
      const [method, apiPath] = endpoint.split(' ');
      for (const codePage of codePages) {
        const hasPath = codePage.text.includes(apiPath);
        const hasMethod = codePage.text.includes(method);
        if (!hasPath) continue;
        const factors: ConfidenceFactor[] = [
          { name: 'path_match', weight: 0.7 },
          ...(hasMethod ? [{ name: 'method_match', weight: 0.3 }] : []),
        ];
        apiMatches.push({
          apiPagePath: productPage.path,
          interfacePagePath: codePage.path,
          method,
          path: apiPath,
          confidence: buildConfidence(factors),
        });
      }
    }
  }

  // Phase 8 — Rule↔Code matching
  for (const productPage of productPages) {
    const rulePatterns = productPage.text.match(/`[^`]{3,50}`/g) ?? [];
    for (const rawPattern of rulePatterns) {
      const pattern = rawPattern.replace(/`/g, '');
      for (const codePage of codePages) {
        if (!codePage.text.includes(pattern)) continue;
        const factors: ConfidenceFactor[] = [{ name: 'rule_pattern_match', weight: 0.85 }];
        ruleMatches.push({
          rulePagePath: productPage.path,
          codePagePath: codePage.path,
          matchedPattern: pattern,
          confidence: buildConfidence(factors),
        });
      }
    }
  }

  // Phase 9 — Stale detection
  const MS_PER_DAY = 86_400_000;
  for (const edge of graphEdges) {
    const fromPage = productPages.find(
      p => toPageSlug(path.relative(wikiRoot, p.path)) === edge.from
    );
    const toPage = codePages.find(
      p => toPageSlug(path.relative(wikiRoot, p.path)) === edge.to
    );
    if (!fromPage?.updated || !toPage?.updated) continue;
    const fromMs = new Date(fromPage.updated).getTime();
    const toMs = new Date(toPage.updated).getTime();
    const daysDrift = Math.abs(fromMs - toMs) / MS_PER_DAY;
    if (daysDrift > 30) {
      staleWarnings.push({
        mappingFrom: edge.from,
        mappingTo: edge.to,
        fromUpdated: fromPage.updated,
        toUpdated: toPage.updated,
        daysDrift: Math.round(daysDrift),
        severity: daysDrift > 60 ? 'critical' : 'warning',
      });
    }
  }

  const existing = await loadReconciliationBase(wikiRoot);

  // Replace the reconciliation overlay so removed matches cannot leave stale state.
  if (!dryRun) {
    const baseEdges = existing.edges.filter(edge => edge.source !== BRIDGE_EDGE_SOURCE);
    const preservedNodeSlugs = new Set(baseEdges.flatMap(edge => [edge.from, edge.to]));
    const baseNodes = existing.nodes.filter(
      node => node.source !== BRIDGE_EDGE_SOURCE || preservedNodeSlugs.has(node.slug),
    );
    const existingNodeSlugs = new Set(
      baseNodes.filter(node => node.source !== BRIDGE_EDGE_SOURCE).map(node => node.slug),
    );
    const pageNodes: GraphNode[] = [
      ...productPages.map(page => ({
        slug: toPageSlug(path.relative(wikiRoot, page.path)),
        type: PRODUCT_PAGE_TYPE,
        confidence: PAGE_CONFIDENCE,
        title: page.title,
        domain: PRODUCT_PAGE_DOMAIN,
        source: BRIDGE_EDGE_SOURCE,
      })),
      ...codePages.map(page => ({
        slug: toPageSlug(path.relative(wikiRoot, page.path)),
        type: CODE_PAGE_TYPE,
        confidence: PAGE_CONFIDENCE,
        title: page.title,
        domain: CODE_PAGE_DOMAIN,
        source: BRIDGE_EDGE_SOURCE,
      })),
    ].filter(node => !existingNodeSlugs.has(node.slug));
    const newEdges: GraphEdge[] = graphEdges.map(e => ({
      from: e.from,
      to: e.to,
      relation: e.relation,
      weight: e.confidenceScore,
      source: BRIDGE_EDGE_SOURCE,
    }));
    const base = createGraphIndex(
      baseNodes,
      baseEdges,
    );
    const refreshedNodes = mergeGraphs(base, createGraphIndex(pageNodes)).nodes;
    const merged = mergeGraphs(
      createGraphIndex(refreshedNodes, newEdges),
      createGraphIndex([], baseEdges),
    );
    await saveGraphIndex(wikiRoot, merged);
  }

  const durationMs = Date.now() - startMs;
  const mappingCount = new Set(graphEdges.map(e => JSON.stringify([e.from, e.to]))).size;
  const allScores = graphEdges.map(e => e.confidenceScore ?? 0);
  const averageConfidence = allScores.length > 0
    ? allScores.reduce((a, b) => a + b, 0) / allScores.length
    : 0;

  const stats: ReconcileStats = {
    totalProductPages: productPages.length,
    totalCodePages: codePages.length,
    mappingsCreated: mappingCount,
    gapsDetected: gaps.length,
    conflictsDetected: conflicts.length,
    apiMatchesFound: apiMatches.length,
    ruleMatchesFound: ruleMatches.length,
    staleWarningsRaised: staleWarnings.length,
    averageConfidence,
    durationMs,
  };

  return {
    mappings: mappingCount,
    gaps,
    conflicts,
    graphEdges,
    apiMatches,
    ruleMatches,
    staleWarnings,
    stats,
  };
}
