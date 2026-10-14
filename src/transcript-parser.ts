// -*- coding: utf-8 -*-
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * The fixed start/end sentinels teamai's recall output prints (see recall.ts
 * `formatResults`). Used by `extractRecalledDocIds` to delimit a recall region
 * when parsing doc-ids.
 */
const RECALL_REGION_START = '--- [teamai:recall:start] ---';
const RECALL_REGION_END = '--- [teamai:recall:end] ---';

export interface TranscriptVoteData {
  recalledDocIds: string[];
  /**
   * The last main-conversation (non-sidechain) assistant text block. Used by
   * the optional background LLM-judge to decide, after the session, whether the
   * final reply substantively used each recalled doc — without requiring the
   * model to self-declare. Empty string when no assistant text is present.
   */
  finalAssistantText: string;
  /**
   * Recalled doc-id → the file path it was recalled from (first occurrence).
   * The optional LLM-judge reads these files so its verdict is grounded in the
   * doc's actual content, not just its id. Only recalled docs appear here.
   */
  recalledDocPaths: Record<string, string>;
  /**
   * Recalled doc-id → the SCOPE it was recalled from (`project` / `user`), taken
   * from the `[workspace]` (older recalls: `[project]`) / `[user]` label recall prints on each hit. `'unknown'`
   * when no label was present (legacy/forged region). The judge uses this so a
   * doc recalled from the inherited USER scope is not upvoted into the active
   * PROJECT team's vote file — inherited user hits are read-only while a
   * project is active (issue #723 review; matches recall.ts's recalled_count
   * scoping and the documented read-only rule). Only recalled docs appear here.
   */
  recalledDocScopes: Record<string, 'project' | 'user' | 'unknown'>;
}

function emptyResult(): TranscriptVoteData {
  return {
    recalledDocIds: [],
    finalAssistantText: '',
    recalledDocPaths: {},
    recalledDocScopes: {},
  };
}

/**
 * Parse a Claude Code JSONL transcript file and extract the doc IDs its
 * recall regions and recalled-doc-ids markers name, for the opt-in judge.
 */
export async function parseTranscriptForVotes(transcriptPath: string): Promise<TranscriptVoteData> {
  const recalledSet = new Set<string>();

  // tool_use ids of plain file readers (Read/Bash/Grep/Glob…). A recall region
  // found in THEIR result is the CONTENT of a file the agent opened, not teamai's
  // own recall output — trusting it would let a user-authored .md forge doc-ids
  // (issue #723 review). Recall regions are parsed only from non-reader results.
  const readerToolUseIds = new Set<string>();
  // tool_result recall regions buffered until the whole transcript is scanned,
  // so we know which results came from readers (untrusted content) vs teamai's
  // own recall output (trusted).
  const deferredResultRegions: Array<{ id?: string; content: unknown }> = [];
  // Recalled doc-id -> original file path (for the optional LLM-judge to read).
  const docIdToPath = new Map<string, string>();
  // Recalled doc-id -> scope it was recalled from ('project'/'user'/'unknown'),
  // first occurrence wins. Drives per-scope upvote attribution in the handler.
  const docIdToScope = new Map<string, 'project' | 'user' | 'unknown'>();
  // Last main-conversation assistant message text (for the optional LLM-judge).
  // Some hosts serialize ONE logical assistant message across several JSONL
  // records that share a message id, so we accumulate by id: text from records
  // with the same id as the current final message is appended, and a new id
  // starts a fresh final message. Hosts that emit one record per message (e.g.
  // Claude Code) simply see each id once, which reduces to the last message.
  let finalAssistantText = '';
  let finalAssistantId: string | undefined;

  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size === 0) return emptyResult();
  } catch {
    return emptyResult();
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // NOTE: the recalled-doc-ids COMMENT marker is scanned only from TRUSTED
    // origins below (assistant text and non-reader tool_results), never from the
    // raw JSONL line. Scanning the raw line pre-parse would harvest a forged
    // marker embedded in file content the agent Read (serialized in a reader
    // tool_result), manufacturing a doc-id and defeating the reader-trust gate
    // (issue #723 review). Region-form markers were already gated; the comment
    // form now matches.
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Trusted fallback surfaces for recall markers that live OUTSIDE a structured
    // message.content[] block (host schema variance): teamai's own recall stdout
    // in top-level `toolUseResult.stdout`, and a plain-STRING `message.content`.
    // These are teamai output, not the body of a file a reader tool returned, so
    // they are trusted (unlike a reader tool_result block, which is gated below).
    const topResult = entry['toolUseResult'];
    if (topResult && typeof topResult === 'object') {
      const stdout = (topResult as Record<string, unknown>)['stdout'];
      if (typeof stdout === 'string') {
        extractRecalledDocIdsFromComment(stdout, recalledSet);
        extractRecalledDocIds(stdout, recalledSet, docIdToPath, docIdToScope);
      }
    }

    const message = entry['message'] as Record<string, unknown> | undefined;
    if (message && typeof message['content'] === 'string') {
      const s = message['content'] as string;
      extractRecalledDocIdsFromComment(s, recalledSet);
      extractRecalledDocIds(s, recalledSet, docIdToPath, docIdToScope);
    }
    if (!message || !Array.isArray(message['content'])) continue;

    // Subagent-internal messages (the teamai-recall Task subagent's own work)
    // are marked isSidechain: their tool results and text are not the main
    // conversation's.
    const isSidechain = entry['isSidechain'] === true;

    // Collect ALL text blocks of THIS assistant message so a multipart final
    // reply is judged in full, not just its last fragment (issue #723 review).
    const messageTextParts: string[] = [];

    for (const block of message['content'] as Array<Record<string, unknown>>) {
      if (block['type'] === 'tool_result') {
        // Recall regions/markers in a tool_result: teamai's own recall output
        // (Task subagent / Bash `teamai recall`) is a trusted origin, but the
        // result of a plain file READER is just the CONTENT of a file the agent
        // opened, where a user-authored .md could carry a FORGED recall region
        // (issue #723 review). Buffered, because reader ids are only fully
        // known after the whole transcript is scanned.
        const tid = block['tool_use_id'] ?? block['toolUseId'];
        if (!isSidechain) deferredResultRegions.push({ id: typeof tid === 'string' ? tid : undefined, content: block['content'] });
      }

      // Reader ids, so their results are treated as untrusted content.
      if (block['type'] === 'tool_use') {
        const id = typeof block['id'] === 'string' ? (block['id'] as string) : undefined;
        const name = typeof block['name'] === 'string' ? block['name'].toLowerCase() : '';
        if (id && READ_LIKE_TOOLS.has(name)) readerToolUseIds.add(id);
      }

      if (entry['type'] !== 'assistant' || block['type'] !== 'text') continue;
      const text = block['text'];
      if (typeof text !== 'string') continue;

      messageTextParts.push(text);
      // Assistant text is a TRUSTED origin for recall regions (this is where
      // teamai injects them / the model echoes them) — scan BOTH the region form
      // and the legacy `<!-- teamai:recalled-doc-ids:[…] -->` comment form here,
      // not on the raw JSONL line, so a forged comment inside file content the
      // agent Read (which lands in a reader tool_result) can't manufacture a
      // doc-id (issue #723 review).
      extractRecalledDocIdsFromComment(text, recalledSet);
      extractRecalledDocIds(text, recalledSet, docIdToPath, docIdToScope);
    }

    // Track the latest main-conversation assistant message as the "final reply".
    // Sidechain assistant text is subagent chatter, not the user-facing answer.
    // Accumulate across records that share one message id (see finalAssistantId).
    if (!isSidechain && entry['type'] === 'assistant' && messageTextParts.length > 0) {
      const msgId = typeof message['id'] === 'string' ? (message['id'] as string) : undefined;
      const joined = messageTextParts.join('\n');
      if (msgId !== undefined && msgId === finalAssistantId) {
        // Same logical message split across records — append, don't replace.
        finalAssistantText = finalAssistantText ? `${finalAssistantText}\n${joined}` : joined;
      } else {
        // A new (or id-less) assistant message becomes the current final reply.
        finalAssistantText = joined;
        finalAssistantId = msgId;
      }
    }
  }

  // Buffered tool_result recall regions, now that reader ids are known. Only a
  // non-reader result (teamai's own Task/Bash recall output) is a TRUSTED
  // origin. A reader result is the content of a file the agent opened, so a
  // recall region there adds no doc-id, and cannot set the path or scope of a
  // legitimately-recalled one either (first occurrence wins).
  for (const { id, content } of deferredResultRegions) {
    if (id !== undefined && readerToolUseIds.has(id)) continue;
    extractRecalledDocIdsFromValue(content, recalledSet, docIdToPath, docIdToScope);
  }

  return {
    recalledDocIds: [...recalledSet],
    finalAssistantText,
    recalledDocPaths: Object.fromEntries(
      [...docIdToPath].filter(([id]) => recalledSet.has(id)),
    ),
    recalledDocScopes: Object.fromEntries(
      [...recalledSet].map((id) => [id, docIdToScope.get(id) ?? 'unknown']),
    ),
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

function extractRecalledDocIdsFromValue(
  value: unknown,
  out: Set<string>,
  docIdToPath: Map<string, string>,
  docIdToScope: Map<string, 'project' | 'user' | 'unknown'>,
): void {
  if (typeof value === 'string') {
    extractRecalledDocIdsFromComment(value, out);
    extractRecalledDocIds(value, out, docIdToPath, docIdToScope);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractRecalledDocIdsFromValue(item, out, docIdToPath, docIdToScope);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      extractRecalledDocIdsFromValue(item, out, docIdToPath, docIdToScope);
    }
  }
}

function extractRecalledDocIds(
  text: string,
  out: Set<string>,
  docIdToPath: Map<string, string>,
  docIdToScope: Map<string, 'project' | 'user' | 'unknown'>,
): void {
  let searchFrom = 0;
  while (true) {
    const startIdx = text.indexOf(RECALL_REGION_START, searchFrom);
    if (startIdx === -1) break;

    const endIdx = text.indexOf(RECALL_REGION_END, startIdx + RECALL_REGION_START.length);
    if (endIdx === -1) break;

    const region = text.slice(startIdx + RECALL_REGION_START.length, endIdx);
    // Walk the region line-by-line so each `File:` inherits the scope label
    // from the hit header that precedes it. recall prints a header per hit —
    // `[i/N] [type] Title ★votes [workspace]` — then a `File:` line. The `[user]`
    // / `[workspace]` tag is how we attribute the upvote to the right scope;
    // `[project]` is what a recall older than #1099 printed for the workspace.
    let currentScope: 'project' | 'user' | 'unknown' = 'unknown';
    for (const rawLine of region.split('\n')) {
      const line = rawLine.trim();
      const header = line.match(/^\[\d+\/\d+\]/);
      if (header) {
        // Reset per hit, then read the trailing [workspace]/[project]/[user] tag if present.
        currentScope = 'unknown';
        const scopeTag = line.match(/\[(workspace|project|user)\]\s*$/);
        if (scopeTag) currentScope = scopeTag[1] === 'user' ? 'user' : 'project';
        continue;
      }
      const fileMatch = line.match(/^File:\s*(.+)$/);
      if (fileMatch) {
        const filePath = fileMatch[1].trim();
        const docId = path.basename(filePath).replace(/\.md$/i, '');
        if (isValidDocId(docId)) {
          out.add(docId);
          // First occurrence wins, so the LLM-judge reads the doc's real content.
          if (!docIdToPath.has(docId)) docIdToPath.set(docId, filePath);
          if (!docIdToScope.has(docId)) docIdToScope.set(docId, currentScope);
        }
      }
    }

    searchFrom = endIdx + RECALL_REGION_END.length;
  }
}

/**
 * Plain file readers: a recall region in their result is the content of a file
 * the agent opened, not teamai's own recall output, so it is never trusted.
 */
const READ_LIKE_TOOLS = new Set([
  'read', 'grep', 'glob', 'bash', 'notebookread', 'readfile', 'readmanyfiles',
]);
