/** What a code fact is, and the wiki evidence type each kind counts as. */
export type CodeFactKind = "component" | "interface" | "config" | "error" | "data" | "style" | "relation";

export type CodeEvidenceType = "definition" | "implementation" | "usage" | "schema" | "config";

/**
 * Map a CodeFactKind to a WikiEvidenceType.
 */
export function mapKindToEvidenceType(kind: CodeFactKind): CodeEvidenceType {
  switch (kind) {
    case "component":
    case "interface":
    case "error":
      return "definition";
    case "config":
      return "config";
    case "data":
      return "schema";
    case "relation":
      return "usage";
    case "style":
      return "definition";
    default: {
      const unhandled: never = kind;

      return unhandled;
    }
  }
}
