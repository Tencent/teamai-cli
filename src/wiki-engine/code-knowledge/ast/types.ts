import type { ManifestConfidence } from "../../manifest-schema.js";
import type { WikiEvidence } from "../../core/wiki-protocol.js";

export type AstSymbolKind = "function" | "class" | "interface" | "method" | "variable";

export interface AstSymbol {
  id: string;
  kind: AstSymbolKind;
  name: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
}

export interface AstImport {
  fromFile: string;
  specifier: string;
  line: number;
  isTypeOnly: boolean;
  namedBindings?: string[];
  defaultBinding?: string;
  namespaceBinding?: string;
}

export interface AstCallSite {
  fromFile: string;
  line: number;
  calleeText: string;
  receiver?: string;
  resolvedTargetId?: string;
  resolvedTargetFile?: string;
  confidence: ManifestConfidence;
}

export type StructuralRelation = "DEPENDS_ON" | "REFERENCES" | "IMPLEMENTS";

export interface StructuralEdge {
  from: string;
  to: string;
  relation: StructuralRelation;
  source: "code-ast";
  weight: number;
  evidence: WikiEvidence[];
  confidence: ManifestConfidence;
}

export interface AstExtractionGap {
  kind: string;
  message: string;
  sources: string[];
}

export interface AstExtractionStats {
  symbols: number;
  imports: number;
  importsResolved: number;
  calls: number;
  callsResolved: number;
  edges: number;
  filesParsed: number;
  filesSkipped: number;
}

export interface StructuralGraphResult {
  symbols: AstSymbol[];
  imports: AstImport[];
  callSites: AstCallSite[];
  edges: StructuralEdge[];
  gaps: AstExtractionGap[];
  stats: AstExtractionStats;
}
