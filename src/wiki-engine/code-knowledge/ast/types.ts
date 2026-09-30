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
  /**
   * Swift only. The names that could bind this call's callee (or receiver),
   * gathered from the top-level declaration that encloses the call site:
   * function and closure parameters, local `let`/`var`, and whatever a
   * `for` / `if let` / `guard let` / `catch let` / `case let` introduces, plus
   * stored properties, generic parameters and closure capture lists.
   *
   * A call whose callee (or receiver) is one of these names refers to that
   * binding, so a module-wide lookup must not claim it: `run(work:) { work() }`
   * calls the parameter, not a sibling file's `func work()`. Only the syntax
   * tree knows this, which is why it is recorded here and not recomputed in the
   * resolver.
   *
   * Collected per declaration rather than per call site, so it is deliberately
   * coarse: the declaration is read whole, and a name that merely occurs in it —
   * passed around as an argument rather than bound — counts. Both directions of
   * error are not equal here: an extra name costs a resolution, a missing one
   * invents a cross-file edge. Absent for non-Swift files and for sites with no
   * such binding.
   */
  localBindings?: string[];
  resolvedTargetId?: string;
  resolvedTargetFile?: string;
  confidence: ManifestConfidence;
}

export interface AstImplementsSite {
  fromFile: string;
  className: string;
  ifaceNames: string[];
  line: number;
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
