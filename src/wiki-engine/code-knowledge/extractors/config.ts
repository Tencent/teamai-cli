import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact, type CodeFactKind, mapKindToEvidenceType } from "../code-extractors.js";

function makeFact(kind: CodeFactKind, name: string, file: string, line: number, detail: string): CodeFact {
  return { kind, name, file, lineStart: line, detail, confidence: "EXTRACTED", evidenceType: mapKindToEvidenceType(kind) };
}

/**
 * Extract config facts from TOML/INI/CONF files.
 * Captures section headers and key-value pairs.
 */
export function extractToml(files: CodeCollectedFile[]): CodeFact[] {
  const facts: CodeFact[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // [section] headers
      const sectionMatch = line.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        facts.push(makeFact("config", sectionMatch[1], file.relativePath, i + 1, line));
        continue;
      }
      // KEY = value (uppercase keys are likely env/config constants)
      const kvMatch = line.match(/^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+)/);
      if (kvMatch) {
        facts.push(makeFact("config", kvMatch[1], file.relativePath, i + 1, line));
      }
    }
  }
  return facts;
}

/**
 * Extract facts from SQL files.
 * Captures CREATE TABLE/INDEX, ALTER TABLE, and key INSERT patterns.
 */
export function extractSql(files: CodeCollectedFile[]): CodeFact[] {
  const facts: CodeFact[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // CREATE TABLE
      const createTable = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/i);
      if (createTable) {
        facts.push(makeFact("data", createTable[1], file.relativePath, i + 1, line));
        continue;
      }
      // ALTER TABLE
      const alterTable = line.match(/ALTER\s+TABLE\s+[`"']?(\w+)[`"']?/i);
      if (alterTable) {
        facts.push(makeFact("data", `alter:${alterTable[1]}`, file.relativePath, i + 1, line));
        continue;
      }
      // CREATE INDEX
      const createIndex = line.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+[`"']?(\w+)[`"']?/i);
      if (createIndex) {
        facts.push(makeFact("data", `index:${createIndex[1]}`, file.relativePath, i + 1, line));
      }
    }
  }
  return facts;
}
