/**
 * Team Wiki Engine — vendored from Team Wiki project by @lurkacai.
 * Core concepts: code fact extraction, knowledge graph, evidence pages.
 */

export { collectCode } from '../code-knowledge/code-collector.js';
export type { CodeCollectedFile, CollectCodeOptions } from '../code-knowledge/code-collector.js';

export { extractCodeFacts } from '../code-knowledge/code-extractors.js';
export type { CodeFact, CodeFactKind, CodeEvidenceType } from '../code-knowledge/code-extractors.js';

export { buildCodeGraph, buildCodeGraphIndex } from '../code-knowledge/code-graph.js';
export type { CodeGraphIndex } from '../code-knowledge/code-graph.js';

export { detectCodeIncrementalChanges } from '../code-knowledge/code-incremental.js';

export {
  mergeGraphs,
  loadGraphIndex,
  saveGraphIndex,
  createGraphIndex,
  findNeighbors,
  findNeighborsNHop,
  GRAPH_INDEX_SCHEMA_VERSION,
} from '../core/graph-index.schema.js';
export type { GraphIndex, GraphNode, GraphEdge, RelationType } from '../core/graph-index.schema.js';
