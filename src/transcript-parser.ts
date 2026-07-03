// -*- coding: utf-8 -*-
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export interface TranscriptVoteData {
  recalledDocIds: string[];
  referencedDocIds: string[];
}

/**
 * Parse a Claude Code JSONL transcript file and extract doc IDs
 * from recall and reference markers in assistant messages.
 */
export async function parseTranscriptForVotes(transcriptPath: string): Promise<TranscriptVoteData> {
  const recalledSet = new Set<string>();
  const referencedSet = new Set<string>();

  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size === 0) return { recalledDocIds: [], referencedDocIds: [] };
  } catch {
    return { recalledDocIds: [], referencedDocIds: [] };
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('"assistant"')) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry['type'] !== 'assistant') continue;

    const message = entry['message'] as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message['content'])) continue;

    for (const block of message['content'] as Array<Record<string, unknown>>) {
      if (block['type'] !== 'text') continue;
      const text = block['text'];
      if (typeof text !== 'string') continue;

      extractRecalledDocIds(text, recalledSet);
      extractReferencedDocIds(text, referencedSet);
    }
  }

  return {
    recalledDocIds: [...recalledSet],
    referencedDocIds: [...referencedSet],
  };
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
      out.add(docId);
    }

    searchFrom = endIdx + END.length;
  }
}

function extractReferencedDocIds(text: string, out: Set<string>): void {
  const pattern = /<!--\s*teamai:referenced-doc-ids:\s*\[([^\]]*)\]\s*-->/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1];
    for (const item of raw.split(',')) {
      const docId = item.trim().replace(/^['"]|['"]$/g, '');
      if (docId) out.add(docId);
    }
  }
}
