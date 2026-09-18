// -*- coding: utf-8 -*-
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export interface TranscriptVoteData {
  recalledDocIds: string[];
  referencedDocIds: string[];
  /** Whether the model wrote any `<!-- teamai:referenced-doc-ids: [...] -->` marker. */
  hasReferencedDocIdsDeclaration: boolean;
}

/**
 * Parse a Claude Code JSONL transcript file and extract doc IDs
 * from recall and reference markers in assistant messages.
 */
export async function parseTranscriptForVotes(transcriptPath: string): Promise<TranscriptVoteData> {
  const recalledSet = new Set<string>();
  const referencedSet = new Set<string>();
  let hasDeclaration = false;

  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size === 0) return { recalledDocIds: [], referencedDocIds: [], hasReferencedDocIdsDeclaration: false };
  } catch {
    return { recalledDocIds: [], referencedDocIds: [], hasReferencedDocIdsDeclaration: false };
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Host transcript schemas vary. Keep a raw-line fallback for recalled
    // markers that may live outside message.content (for example a plain
    // content string or top-level toolUseResult.stdout). Parsed scans below
    // additionally handle multiline recall regions after JSON decoding.
    extractRecalledDocIdsFromComment(trimmed, recalledSet);

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const message = entry['message'] as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message['content'])) continue;

    for (const block of message['content'] as Array<Record<string, unknown>>) {
      // Subagent and Bash recall output lands in a tool_result. Scan its decoded
      // content recursively because some hosts represent it as nested blocks.
      if (block['type'] === 'tool_result') {
        extractRecalledDocIdsFromValue(block['content'], recalledSet);
      }

      if (entry['type'] !== 'assistant' || block['type'] !== 'text') continue;
      const text = block['text'];
      if (typeof text !== 'string') continue;

      extractRecalledDocIds(text, recalledSet);
      if (extractReferencedDocIds(text, referencedSet)) {
        hasDeclaration = true;
      }
    }
  }

  return {
    recalledDocIds: [...recalledSet],
    referencedDocIds: [...referencedSet],
    hasReferencedDocIdsDeclaration: hasDeclaration,
  };
}

/**
 * Reject placeholder-shaped tokens (e.g. `<id1>`, `<id2>`, `...`) that appear in
 * documentation/agent example markers. Real doc-ids are kebab-case slugs and
 * never contain angle brackets nor are a bare ellipsis.
 */
function isValidDocId(docId: string): boolean {
  return docId.length > 0 && !/[<>]/.test(docId) && docId !== '...';
}

function extractRecalledDocIdsFromComment(text: string, out: Set<string>): void {
  const pattern = /(?:<!--|<!—)\s*teamai:recalled-doc-ids:\s*\[([^\]]*)\]\s*(?:-->|—>)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    for (const item of match[1].split(',')) {
      const docId = item.trim().replace(/^['"]|['"]$/g, '');
      if (isValidDocId(docId)) out.add(docId);
    }
  }
}

function extractRecalledDocIdsFromValue(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    extractRecalledDocIdsFromComment(value, out);
    extractRecalledDocIds(value, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractRecalledDocIdsFromValue(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      extractRecalledDocIdsFromValue(item, out);
    }
  }
}

function extractRecalledDocIds(text: string, out: Set<string>): void {
  const START = '--- [teamai:recall:start] ---';
  const END = '--- [teamai:recall:end] ---';
  const filePattern = /^File:\s*(.+)$/gm;

  let searchFrom = 0;
  while (true) {
    const startIdx = text.indexOf(START, searchFrom);
    if (startIdx === -1) break;

    const endIdx = text.indexOf(END, startIdx + START.length);
    if (endIdx === -1) break;

    const region = text.slice(startIdx + START.length, endIdx);
    filePattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = filePattern.exec(region)) !== null) {
      const filePath = match[1].trim();
      const docId = path.basename(filePath).replace(/\.md$/i, '');
      if (isValidDocId(docId)) out.add(docId);
    }

    searchFrom = endIdx + END.length;
  }
}

function extractReferencedDocIds(text: string, out: Set<string>): boolean {
  // Case-insensitive; accept smart-punctuation variants of both delimiters.
  // Closed delimiter is required — bare [^\]]* prevents unclosed strings from bleeding past.
  const pattern = /(?:<!--|<!—)\s*teamai:referenced-doc-ids:\s*\[([^\]]*)\]\s*(?:-->|—>)/gi;
  let found = false;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1];
    // A declaration counts only when it is explicitly empty or carries at least
    // one valid id; a placeholder-only list like `[<id1>]` is not a declaration.
    if (raw.trim() === '') found = true;
    for (const item of raw.split(',')) {
      const docId = item.trim().replace(/^['"]|['"]$/g, '');
      if (isValidDocId(docId)) {
        out.add(docId);
        found = true;
      }
    }
  }
  return found;
}
