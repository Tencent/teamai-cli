import type { GraphEdge, GraphNode } from './core/graph-index.schema.js';
import { CONFIDENCE_SCORE_DEFAULTS, slugifyWiki, type WikiCategory, type WikiEvidence } from './core/wiki-protocol.js';

function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const link = match[1].trim();
    if (link) {
      links.push(link);
    }
  }
  return links;
}

export interface DocGraphExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ExtractDocStructureOptions {
  pageCategory?: WikiCategory;
  pageTitle?: string;
  domain?: string;
}

/**
 * Section node slugs use `{pageSlug}#{section-slug}` (see GRAPH-CAPABILITIES.md).
 */
export function sectionNodeSlug(pageSlug: string, sectionSlug: string): string {
  return `${pageSlug}#${sectionSlug}`;
}

export function extractDocStructure(
  content: string,
  pageSlug: string,
  pageRelativePath: string,
  options: ExtractDocStructureOptions = {}
): DocGraphExtraction {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const category = options.pageCategory ?? "source";
  const domain = options.domain ?? "product";
  const title = options.pageTitle ?? pageSlug;

  const pageNode: GraphNode = {
    slug: pageSlug,
    type: category,
    confidence: "EXTRACTED",
    title,
    domain
  };
  nodes.push(pageNode);

  const sectionSlugCounts = new Map<string, number>();
  const headingPattern = /^#{2,3}\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(content)) !== null) {
    const heading = match[1].trim();
    if (!heading) {
      continue;
    }
    const baseSectionSlug = slugifyWiki(heading);
    const count = (sectionSlugCounts.get(baseSectionSlug) ?? 0) + 1;
    sectionSlugCounts.set(baseSectionSlug, count);
    const sectionSlug = count > 1 ? `${baseSectionSlug}-${count}` : baseSectionSlug;
    const sectionId = sectionNodeSlug(pageSlug, sectionSlug);
    const lineStart = lineNumberAt(content, match.index);

    nodes.push({
      slug: sectionId,
      type: category,
      confidence: "EXTRACTED",
      title: heading,
      domain
    });
    edges.push({
      from: pageSlug,
      to: sectionId,
      relation: "CONTAINS",
      weight: CONFIDENCE_SCORE_DEFAULTS.EXTRACTED,
      evidence: docEvidence(pageRelativePath, lineStart, "doc-structure section")
    });
  }

  for (const link of extractWikiLinks(content)) {
    const targetSlug = wikiLinkToPageSlug(link);
    if (!targetSlug || targetSlug === pageSlug) {
      continue;
    }
    const lineStart = findLinkLine(content, link);
    edges.push({
      from: pageSlug,
      to: targetSlug,
      relation: "REFERENCES",
      weight: CONFIDENCE_SCORE_DEFAULTS.EXTRACTED,
      evidence: docEvidence(pageRelativePath, lineStart, `doc-structure wiki link [[${link}]]`)
    });
  }

  return dedupeExtraction({ nodes, edges });
}

export function extractDocEntities(
  content: string,
  pageSlug: string,
  pageRelativePath: string
): DocGraphExtraction {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenEntitySlugs = new Set<string>();

  const apiPattern = /(GET|POST|PUT|DELETE|PATCH)\s+(\/[a-z0-9/_\-{}:.]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = apiPattern.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const apiPath = match[2].toLowerCase();
    const entitySlug = entitySlugFor("api", `${method}-${apiPath}`);
    addEntity(entitySlug, "interface", `${method} ${apiPath}`, match.index);
  }

  const errPattern = /\b(Err\d{3,8})\b/gi;
  while ((match = errPattern.exec(content)) !== null) {
    const code = match[1];
    addEntity(entitySlugFor("error", code.toLowerCase()), "error", code, match.index);
  }

  const errRangePattern = /\b(Err\d{3,8})\s*[-–—]\s*(Err\d{3,8})\b/gi;
  while ((match = errRangePattern.exec(content)) !== null) {
    const rangeLabel = `${match[1]}-${match[2]}`;
    addEntity(entitySlugFor("error-range", rangeLabel.toLowerCase()), "error", rangeLabel, match.index);
  }

  const configBacktickPattern = /`([A-Z][A-Z0-9_]{2,})`/g;
  while ((match = configBacktickPattern.exec(content)) !== null) {
    const key = match[1];
    addEntity(entitySlugFor("config", key.toLowerCase()), "config", key, match.index);
  }

  const configAssignPattern = /^\s*([A-Z][A-Z0-9_]{2,})\s*[:=]\s*/gm;
  while ((match = configAssignPattern.exec(content)) !== null) {
    const key = match[1];
    if (/^(http|https|get|post|put|delete|patch)$/i.test(key)) {
      continue;
    }
    addEntity(entitySlugFor("config", key.toLowerCase()), "config", key, match.index);
  }

  return dedupeExtraction({ nodes, edges });

  function addEntity(entitySlug: string, type: WikiCategory, title: string, index: number): void {
    if (seenEntitySlugs.has(entitySlug)) {
      const existingEdge = edges.find((e) => e.from === pageSlug && e.to === entitySlug && e.relation === "REFERENCES");
      if (!existingEdge) {
        edges.push({
          from: pageSlug,
          to: entitySlug,
          relation: "REFERENCES",
          weight: CONFIDENCE_SCORE_DEFAULTS.INFERRED,
          evidence: docEvidence(pageRelativePath, lineNumberAt(content, index), "doc-entity")
        });
      }
      return;
    }
    seenEntitySlugs.add(entitySlug);
    nodes.push({
      slug: entitySlug,
      type,
      confidence: type === "interface" ? "EXTRACTED" : "INFERRED",
      title,
      domain: "product"
    });
    edges.push({
      from: pageSlug,
      to: entitySlug,
      relation: "REFERENCES",
      weight: type === "interface" ? CONFIDENCE_SCORE_DEFAULTS.EXTRACTED : CONFIDENCE_SCORE_DEFAULTS.INFERRED,
      evidence: docEvidence(pageRelativePath, lineNumberAt(content, index), "doc-entity")
    });
  }
}

export function wikiLinkToPageSlug(link: string): string {
  const clean = link.trim().replace(/^\/+/, "").replace(/\.md$/i, "");
  const last = clean.split("/").filter(Boolean).pop();
  if (!last) {
    return slugifyWiki(clean);
  }
  return slugifyWiki(last);
}

export function entitySlugFor(kind: string, anchor: string): string {
  const normalized = anchor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `doc-entity:${kind}:${normalized || "unknown"}`;
}

function docEvidence(ref: string, lineStart?: number, note?: string): WikiEvidence[] {
  return [{ ref, lineStart, note }];
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function findLinkLine(content: string, link: string): number | undefined {
  const needle = `[[${link}]]`;
  const index = content.indexOf(needle);
  return index >= 0 ? lineNumberAt(content, index) : undefined;
}

function dedupeExtraction(extraction: DocGraphExtraction): DocGraphExtraction {
  const nodeMap = new Map<string, GraphNode>();
  for (const node of extraction.nodes) {
    nodeMap.set(node.slug, node);
  }
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const edge of extraction.edges) {
    const key = `${edge.from}|${edge.to}|${edge.relation}`;
    if (edgeKeys.has(key)) {
      continue;
    }
    edgeKeys.add(key);
    edges.push(edge);
  }
  return { nodes: [...nodeMap.values()], edges };
}
