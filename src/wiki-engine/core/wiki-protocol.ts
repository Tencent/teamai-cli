import path from "node:path";

export type WikiCategory =
  | "architecture"
  | "component"
  | "interface"
  | "flow"
  | "data"
  | "config"
  | "error"
  | "rule"
  | "style"
  | "mapping"
  | "decision"
  | "process"
  | "source"
  | "query"
  | "incident";

export type WikiConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
export type WikiReviewState = "draft" | "needs-review" | "accepted";
export type WikiPageStatus = "draft" | "usable" | "stale" | "deprecated";

export const CONFIDENCE_SCORE_DEFAULTS: Record<WikiConfidence, number> = {
  EXTRACTED: 1.0,
  INFERRED: 0.75,
  AMBIGUOUS: 0.2
};

export type WikiEvidenceType = "definition" | "implementation" | "usage" | "schema" | "config";

export interface WikiEvidence {
  ref: string;
  lineStart?: number;
  lineEnd?: number;
  commit?: string;
  type?: WikiEvidenceType;
  /**
   * Optional human-readable note explaining the evidence — e.g. why a graph
   * edge connects two components. Used by manifest v2 edge.reason translation.
   * Renderers that don't recognise this field MUST ignore it (forward-compatible).
   */
  note?: string;
}

export interface WikiPageMetadata {
  title: string;
  category: WikiCategory;
  domain?: string;
  project?: string;
  tags: string[];
  sources: string[];
  evidence: WikiEvidence[];
  confidence: WikiConfidence;
  confidenceScore?: number;
  reviewState: WikiReviewState;
  status?: WikiPageStatus;
  deprecatedBy?: string;
  sourceHash?: Record<string, string>;
  created: string;
  updated: string;
}

export interface WikiPageDraft {
  slug?: string;
  relativePath?: string;
  metadata: WikiPageMetadata;
  summary?: string;
  body: string;
  related?: string[];
}

export interface LocalAiCommandIssue {
  kind: string;
  message: string;
  sources?: string[];
  refs?: string[];
}

export interface LocalAiCommandResult {
  ok: boolean;
  dryRun: boolean;
  command: string;
  summary: string;
  progressPath?: string;
  createdPages: string[];
  updatedPages: string[];
  gaps: Array<{ kind: string; message: string; sources: string[] }>;
  conflicts: Array<{ kind: string; message: string; sources: string[] }>;
  needsReview: Array<{ kind: string; message: string; refs: string[] }>;
  nextActions: string[];
}

export type LocalCompilePhase =
  | "idle"
  | "scanning_code"
  | "extracting_facts"
  | "writing_wiki_pages"
  | "compiling_docs"
  | "reconciling"
  | "building_context"
  | "linting"
  | "done"
  | "failed";

export interface LocalCompileProgress {
  phase: LocalCompilePhase;
  project: string;
  startedAt?: string;
  updatedAt: string;
  createdPages: string[];
  updatedPages: string[];
  gaps: LocalAiCommandResult["gaps"];
  conflicts: LocalAiCommandResult["conflicts"];
  needsReview: LocalAiCommandResult["needsReview"];
  nextActions: string[];
}

export const WIKI_CATEGORIES: WikiCategory[] = [
  "architecture",
  "component",
  "interface",
  "flow",
  "data",
  "config",
  "error",
  "rule",
  "style",
  "mapping",
  "decision",
  "process",
  "source",
  "query",
  "incident"
];

const SAFE_IGNORE_SEGMENTS = new Set([
  ".git",
  ".teamwiki",
  "node_modules",
  "dist",
  "build",
  ".venv",
  "venv",
  "coverage",
  ".next",
  ".turbo"
]);

const SENSITIVE_FILE_NAMES = new Set(["credentials.json"]);

export function safeIgnore(filePath: string): boolean {
  const normalized = toPosix(filePath);
  // Compiled code evidence pages live under .teamwiki/evidence/ and must be writable.
  if (normalized.startsWith(".teamwiki/evidence/")) {
    return false;
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => SAFE_IGNORE_SEGMENTS.has(part))) {
    return true;
  }
  const base = parts.at(-1) ?? "";
  if (base.startsWith(".env") || SENSITIVE_FILE_NAMES.has(base)) {
    return true;
  }
  return /\.(pem|key|p12|pfx)$/i.test(base);
}

export function slugifyWiki(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export function wikiPagePath(page: Pick<WikiPageDraft, "slug" | "relativePath" | "metadata">): string {
  if (page.relativePath) {
    return normalizeRelativePagePath(page.relativePath);
  }
  const domain = page.metadata.domain ?? page.metadata.project ?? "general";
  const slug = page.slug ?? slugifyWiki(page.metadata.title);
  return normalizeRelativePagePath(path.join(domain, `${page.metadata.category}s`, `${slug}.md`));
}

export function normalizeRelativePagePath(value: string): string {
  const normalized = toPosix(value).replace(/^\/+/, "");
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

export function wikiLinkTarget(relativePath: string): string {
  return normalizeRelativePagePath(relativePath).replace(/\.md$/i, "");
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
