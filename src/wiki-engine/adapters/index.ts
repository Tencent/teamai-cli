/**
 * Team Wiki Engine — vendored from Team Wiki project by @lurkacai.
 * Core concepts: code fact extraction, knowledge graph, evidence pages.
 */

export { collectCode } from '../code-knowledge/code-collector.js';
export type { CodeCollectedFile, CollectCodeOptions } from '../code-knowledge/code-collector.js';

export { extractCodeFacts } from '../code-knowledge/code-extractors.js';
export type { CodeFact, CodeFactKind, CodeEvidenceType } from '../code-knowledge/code-extractors.js';

export { buildCodeGraph, buildCodeGraphIndex } from '../code-knowledge/code-graph.js';
export type { CodeGraphIndex } from '../code-knowledge/code-graph.js'; // deprecated alias for GraphIndex

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

export { scanInterfaces } from '../interface-scanner.js';
export type { InterfaceInventory, InterfaceInventoryEntry, InterfaceType } from '../interface-scanner.js';

export { traceCallChains } from '../call-chain-tracer.js';
export type { CallChain, CallChainStep, CallChainLayer } from '../call-chain-tracer.js';

export { buildIndexHubOverlay } from '../code-graph-overlay.js';

export { reconcileKnowledge } from '../knowledge-reconciler.js';
export type { ReconcileOptions, ReconcileResult, ReconcileGap, ReconcileConflict, ReconcileGraphEdge } from '../knowledge-reconciler.js';

export { buildConfidence } from '../reconciler-v2-types.js';
export type { NumericConfidence, ConfidenceFactor } from '../reconciler-v2-types.js';
