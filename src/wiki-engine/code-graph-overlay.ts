import {
  createGraphIndex,
  toPageSlug,
  type GraphEdge,
  type GraphNode,
} from './core/graph-index.schema.js';

/** Hub edges from evidence index to kind pages when AST is unavailable. */
export function buildIndexHubOverlay(
  project: string,
  codeOutputDir: string,
  kindPageSlugs: string[],
): ReturnType<typeof createGraphIndex> {
  const indexSlug = toPageSlug(`${codeOutputDir}/${project}/index`);
  const nodes: GraphNode[] = [
    {
      slug: indexSlug,
      type: "architecture",
      confidence: "EXTRACTED",
      title: `${project} code index`,
      domain: "code-knowledge",
    },
  ];
  const edges: GraphEdge[] = [];
  for (const slug of kindPageSlugs) {
    if (slug === indexSlug) {
      continue;
    }
    nodes.push({
      slug,
      type: "component",
      confidence: "EXTRACTED",
      title: slug.split("/").pop() ?? slug,
      domain: "code-knowledge",
    });
    edges.push({
      from: indexSlug,
      to: slug,
      relation: "CONTAINS",
      weight: 0.6,
      source: "code-heuristic",
    });
  }
  return createGraphIndex(nodes, edges);
}
