/**
 * Codebase output manifest schema definitions.
 *
 * The manifest is the contract between AI compilers (e.g. team-wiki-codebase
 * Skill) and the deterministic Node-side compiler (`compileFromManifest`).
 *
 * Two versions are supported:
 *
 * - **v1** — Original schema. Components carry slug/category/upstream/downstream
 *   and basic evidenceRefs. Edges only carry from/to/relation/confidence.
 *
 * - **v2** — Backward-compatible extension. All v1 fields preserved.
 *   Adds:
 *     - `component.entrypoints` / `component.responsibilities` — surfaced in
 *       the rendered component page as standard sections.
 *     - `edge.evidenceRefs` / `edge.reason` / `edge.sourceRange` — translated
 *       into `GraphEdge.evidence: WikiEvidence[]` so the graph "knows why two
 *       components are connected".
 *
 * The compiler dispatches on `schemaVersion` via `isManifestV2`. v1 manifests
 * continue to compile with zero behaviour change.
 */

export type ManifestConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

/** Optional provenance for manifest edges (GRAPH-CAPABILITIES). */
export type ManifestEdgeSource =
  | "code-ast"
  | "code-heuristic"
  | "doc-structure"
  | "doc-entity"
  | "agent";

interface ManifestComponentBase {
  slug: string;
  docPath: string;
  title?: string;
  category: string;
  confidence: ManifestConfidence;
  upstream?: string[];
  downstream?: string[];
  interfaces?: string[];
  errorCodeRanges?: string[];
  evidenceRefs?: string[];
}

interface ManifestEdgeBase {
  from: string;
  to: string;
  relation: string;
  protocol?: string;
  confidence: ManifestConfidence;
  weight?: number;
}

export interface CodebaseOutputManifestV1 {
  schemaVersion: "team-wiki.codebase-output-manifest.v1";
  project: string;
  generatedAt: string;
  components: ManifestComponentBase[];
  edges: ManifestEdgeBase[];
  graphLayers?: Record<string, { path: string; hasStructuredEdges?: boolean }>;
}

export interface ManifestComponentV2 extends ManifestComponentBase {
  entrypoints?: string[];
  responsibilities?: string[];
}

export interface ManifestEdgeV2 extends ManifestEdgeBase {
  evidenceRefs?: string[];
  reason?: string;
  source?: ManifestEdgeSource;
  sourceRange?: { file: string; lines: [number, number] };
}

export interface CodebaseOutputManifestV2 {
  schemaVersion: "team-wiki.codebase-output-manifest.v2";
  project: string;
  generatedAt: string;
  components: ManifestComponentV2[];
  edges: ManifestEdgeV2[];
  graphLayers?: Record<string, { path: string; hasStructuredEdges?: boolean }>;
}

export type CodebaseOutputManifest = CodebaseOutputManifestV1 | CodebaseOutputManifestV2;

export function isManifestV2(manifest: CodebaseOutputManifest): manifest is CodebaseOutputManifestV2 {
  return manifest.schemaVersion === "team-wiki.codebase-output-manifest.v2";
}
