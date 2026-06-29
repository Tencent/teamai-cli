import path from "node:path";

import type { CodeCollectedFile } from './code-knowledge/code-collector.js';
import type { CodeFact } from './code-knowledge/code-extractors.js';

export type InterfaceType = "HTTP" | "MQ" | "RPC" | "NONE";

export interface InterfaceInventoryEntry {
  component: string;
  type: InterfaceType;
  count: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  patterns: string[]; // matched lines (first 5)
}

export interface InterfaceInventory {
  entries: InterfaceInventoryEntry[];
  scannedAt: string;
}

// --- Detection patterns per language/type ---

interface PatternRule {
  type: InterfaceType;
  regex: RegExp;
  languages: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

const DETECTION_RULES: PatternRule[] = [
  // HTTP - Go
  { type: "HTTP", regex: /\.HandleFunc\s*\(/u, languages: ["go"], confidence: "HIGH" },
  { type: "HTTP", regex: /(?:router|r|mux)\.\s*(?:GET|POST|PUT|DELETE|PATCH|Handle)\s*\(/u, languages: ["go"], confidence: "HIGH" },
  { type: "HTTP", regex: /http\.Handle(?:Func)?\s*\(/u, languages: ["go"], confidence: "HIGH" },

  // HTTP - Python
  { type: "HTTP", regex: /@app\.(?:route|get|post|put|delete|patch)\s*\(/u, languages: ["python"], confidence: "HIGH" },
  { type: "HTTP", regex: /@router\.(?:get|post|put|delete|patch)\s*\(/u, languages: ["python"], confidence: "HIGH" },
  { type: "HTTP", regex: /APIRouter\s*\(/u, languages: ["python"], confidence: "MEDIUM" },

  // HTTP - Java
  { type: "HTTP", regex: /@(?:Get|Post|Put|Delete|Patch)Mapping\b/u, languages: ["java"], confidence: "HIGH" },
  { type: "HTTP", regex: /@RequestMapping\b/u, languages: ["java"], confidence: "HIGH" },

  // HTTP - TypeScript/JavaScript
  { type: "HTTP", regex: /(?:router|app)\.\s*(?:get|post|put|delete|patch|use)\s*\(/u, languages: ["typescript", "javascript"], confidence: "HIGH" },
  { type: "HTTP", regex: /@(?:Get|Post|Put|Delete|Patch)\s*\(/u, languages: ["typescript", "javascript"], confidence: "HIGH" },

  // MQ - cross-language
  { type: "MQ", regex: /\.subscribe\s*\(/u, languages: ["typescript", "javascript", "python", "go", "java"], confidence: "MEDIUM" },
  { type: "MQ", regex: /\.consume\s*\(/u, languages: ["typescript", "javascript", "python", "go", "java"], confidence: "MEDIUM" },
  { type: "MQ", regex: /Exchange\s*[({]/u, languages: ["typescript", "javascript", "python", "go", "java"], confidence: "LOW" },
  { type: "MQ", regex: /Topic\s*[({]/u, languages: ["typescript", "javascript", "python", "go", "java"], confidence: "LOW" },
  { type: "MQ", regex: /@KafkaListener\b/u, languages: ["java"], confidence: "HIGH" },
  { type: "MQ", regex: /channel\.consume\s*\(/u, languages: ["typescript", "javascript", "python"], confidence: "HIGH" },

  // RPC - proto files (language: text for .proto)
  { type: "RPC", regex: /^\s*rpc\s+\w+/u, languages: ["text", "proto"], confidence: "HIGH" },
  { type: "RPC", regex: /^\s*service\s+\w+\s*\{/u, languages: ["text", "proto"], confidence: "HIGH" },
  { type: "RPC", regex: /grpc\.NewServer\s*\(/u, languages: ["go"], confidence: "HIGH" },
  { type: "RPC", regex: /@GrpcMethod\s*\(/u, languages: ["typescript", "javascript"], confidence: "HIGH" },
  { type: "RPC", regex: /registerService\s*\(/u, languages: ["go", "java"], confidence: "MEDIUM" },
];

/**
 * Scan collected files and produce an interface inventory per component.
 * Groups files by directory to form logical components, then detects
 * HTTP/MQ/RPC patterns in each.
 */
export async function scanInterfaces(files: CodeCollectedFile[]): Promise<InterfaceInventory> {
  const componentMap = groupByComponent(files);
  const entries: InterfaceInventoryEntry[] = [];

  for (const [component, componentFiles] of componentMap) {
    const matches = detectInterfaces(componentFiles);

    if (matches.length === 0) {
      continue;
    }

    // Group by type and pick dominant
    const byType = new Map<InterfaceType, { count: number; confidence: "HIGH" | "MEDIUM" | "LOW"; patterns: string[] }>();
    for (const match of matches) {
      const existing = byType.get(match.type);
      if (existing) {
        existing.count++;
        existing.confidence = higherConfidence(existing.confidence, match.confidence);
        if (existing.patterns.length < 5) {
          existing.patterns.push(match.line);
        }
      } else {
        byType.set(match.type, { count: 1, confidence: match.confidence, patterns: [match.line] });
      }
    }

    for (const [type, data] of byType) {
      entries.push({
        component,
        type,
        count: data.count,
        confidence: data.confidence,
        patterns: data.patterns,
      });
    }
  }

  entries.sort((a, b) => a.component.localeCompare(b.component) || a.type.localeCompare(b.type));

  return {
    entries,
    scannedAt: new Date().toISOString(),
  };
}

interface PatternMatch {
  type: InterfaceType;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  line: string;
}

function detectInterfaces(files: CodeCollectedFile[]): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (const line of lines) {
      for (const rule of DETECTION_RULES) {
        if (!rule.languages.includes(file.language)) {
          continue;
        }
        if (rule.regex.test(line)) {
          matches.push({
            type: rule.type,
            confidence: rule.confidence,
            line: line.trim().slice(0, 120),
          });
          break; // one match per line is enough
        }
      }
    }
  }

  return matches;
}

function groupByComponent(files: CodeCollectedFile[]): Map<string, CodeCollectedFile[]> {
  const map = new Map<string, CodeCollectedFile[]>();

  for (const file of files) {
    // Use repo + top-level directory as component name, or just directory
    const parts = file.relativePath.split("/");
    let component: string;
    if (file.repo) {
      // For multi-repo: repo/top-dir
      component = parts.length > 1 ? `${file.repo}/${parts[0]}` : file.repo;
    } else {
      // Single repo: use first directory segment or root
      component = parts.length > 1 ? parts[0] : path.basename(path.dirname(file.path));
    }

    const group = map.get(component) ?? [];
    group.push(file);
    map.set(component, group);
  }

  return map;
}

function higherConfidence(a: "HIGH" | "MEDIUM" | "LOW", b: "HIGH" | "MEDIUM" | "LOW"): "HIGH" | "MEDIUM" | "LOW" {
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Scan interfaces using already-extracted CodeFacts (lightweight, avoids re-reading content).
 * Merges fact-based detection with file-content scanning for deeper coverage.
 */
export async function scanInterfacesFromFacts(
  facts: CodeFact[],
  files: CodeCollectedFile[]
): Promise<InterfaceInventory> {
  const factEntries = extractInterfacesFromFacts(facts);
  const fileInventory = await scanInterfaces(files);

  const merged = mergeInventories(factEntries, fileInventory.entries);

  return {
    entries: merged,
    scannedAt: new Date().toISOString(),
  };
}

function extractInterfacesFromFacts(facts: CodeFact[]): InterfaceInventoryEntry[] {
  const componentMatches = new Map<string, Map<InterfaceType, string[]>>();

  for (const fact of facts) {
    if (fact.kind !== "interface") continue;

    const component = componentFromFactFile(fact.file);
    const type = classifyFactAsInterfaceType(fact);
    if (type === "NONE") continue;

    if (!componentMatches.has(component)) {
      componentMatches.set(component, new Map());
    }
    const typeMap = componentMatches.get(component)!;
    const lines = typeMap.get(type) ?? [];
    lines.push(fact.detail.slice(0, 120));
    typeMap.set(type, lines);
  }

  const entries: InterfaceInventoryEntry[] = [];
  for (const [component, typeMap] of componentMatches) {
    for (const [type, matchedLines] of typeMap) {
      const count = matchedLines.length;
      entries.push({
        component,
        type,
        count,
        confidence: count >= 5 ? "HIGH" : count >= 2 ? "MEDIUM" : "LOW",
        patterns: matchedLines.slice(0, 5),
      });
    }
  }

  return entries;
}

function classifyFactAsInterfaceType(fact: CodeFact): InterfaceType {
  const name = fact.name;
  const detail = fact.detail;

  // HTTP: route-like names (e.g. "GET /api/users")
  if (/^(GET|POST|PUT|DELETE|PATCH|ALL)\s+\//u.test(name)) return "HTTP";
  // Check detail against detection rules (language-agnostic check)
  for (const rule of DETECTION_RULES) {
    if (rule.regex.test(detail)) return rule.type;
  }

  return "NONE";
}

function componentFromFactFile(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return parts[0] ?? "root";
  return parts.length > 1 ? parts[0] : "root";
}

function mergeInventories(
  factEntries: InterfaceInventoryEntry[],
  fileEntries: InterfaceInventoryEntry[]
): InterfaceInventoryEntry[] {
  const key = (e: InterfaceInventoryEntry) => `${e.component}::${e.type}`;
  const merged = new Map<string, InterfaceInventoryEntry>();

  // Fact-based entries first (higher trust from structured extraction)
  for (const entry of factEntries) {
    merged.set(key(entry), entry);
  }

  // File-based entries fill gaps or augment
  for (const entry of fileEntries) {
    const k = key(entry);
    if (!merged.has(k)) {
      merged.set(k, entry);
    } else {
      const existing = merged.get(k)!;
      if (entry.count > existing.count) {
        merged.set(k, {
          ...existing,
          count: entry.count,
          confidence: higherConfidence(existing.confidence, entry.confidence),
          patterns: [...new Set([...existing.patterns, ...entry.patterns])].slice(0, 5),
        });
      }
    }
  }

  return [...merged.values()].sort((a, b) => a.component.localeCompare(b.component) || a.type.localeCompare(b.type));
}
