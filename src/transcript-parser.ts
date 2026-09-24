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
   * Doc-ids the agent demonstrably USED via tool calls (opened the recalled
   * doc's file with Read/Grep/Glob/Bash in the same session). This is a
   * zero-cooperation adoption signal that requires no self-declaration by the
   * model. Always a subset of `recalledDocIds`.
   */
  adoptedDocIds: string[];
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
   * from the `[project]`/`[user]` label recall prints on each hit. `'unknown'`
   * when no label was present (legacy/forged region). The Stop handler uses this
   * so a doc recalled from the inherited USER scope is not upvoted into the
   * active PROJECT team's vote file — inherited user hits are read-only while a
   * project is active (issue #723 review; matches recall.ts's recalled_count
   * scoping and the documented read-only rule). Only recalled docs appear here.
   */
  recalledDocScopes: Record<string, 'project' | 'user' | 'unknown'>;
}

function emptyResult(): TranscriptVoteData {
  return {
    recalledDocIds: [],
    adoptedDocIds: [],
    finalAssistantText: '',
    recalledDocPaths: {},
    recalledDocScopes: {},
  };
}

/**
 * Parse a Claude Code JSONL transcript file and extract doc IDs
 * from recall and reference markers in assistant messages.
 */
export async function parseTranscriptForVotes(transcriptPath: string): Promise<TranscriptVoteData> {
  const recalledSet = new Set<string>();

  // Recalled file paths → doc-id, kept in TWO separate maps so a bare-basename
  // key can never masquerade as an exact full-path hit (issue #723 review):
  //   - full path (normalized) → exact-match fast path;
  //   - basename → candidate that MUST still pass the path-suffix guard before
  //     it is credited, so opening some other `setup.md` cannot be attributed to
  //     a recalled `.../learnings/setup.md`.
  const recalledFullPathToDocId = new Map<string, string>();
  const recalledBasenameToDocId = new Map<string, string>();
  const recalledMaps: RecalledPathMaps = {
    full: recalledFullPathToDocId,
    base: recalledBasenameToDocId,
  };
  // Raw tool-call file references collected across the transcript, each tagged
  // with the tool_use id that produced it, matched against the recalled paths
  // after the full scan (a doc may be recalled and opened in either order across
  // turns). The id lets a FAILED tool_result revoke its refs so a rejected or
  // errored Read/Grep/Glob never counts as adoption (issue #723 review). The
  // `cwd` is the transcript entry's working dir, used to resolve a RELATIVE tool
  // path to absolute before matching — so the same relative path opened from two
  // different checkouts is not misattributed to a recalled absolute path in only
  // one of them (issue #723 review, blocking #7).
  const toolFileRefsById: Array<{ ref: string; id?: string; cwd?: string }> = [];
  // tool_use ids whose tool_result was an error → their refs are not adoption.
  const failedToolUseIds = new Set<string>();
  // tool_use ids of plain file readers (Read/Bash/Grep/Glob…). A recall region
  // found in THEIR result is the CONTENT of a file the agent opened, not teamai's
  // own recall output — trusting it would let a user-authored .md forge doc-ids
  // and pollute adoption stats (issue #723 review). We parse recall regions from
  // such results only for doc-ids that were ALSO recalled elsewhere (assistant
  // text or a non-reader result), never as the sole origin.
  const readerToolUseIds = new Set<string>();
  // tool_result recall regions buffered until the whole transcript is scanned,
  // so we know which results came from readers (untrusted content) vs teamai's
  // own recall output (trusted). Each keeps its tool_use_id and the entry's cwd
  // (the latter so a relative path harvested from a reader result can be
  // resolved to absolute later — issue #723 review, blocking #7).
  const deferredResultRegions: Array<{ id?: string; cwd?: string; content: unknown }> = [];
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

    // Working directory of THIS transcript entry (present on user/assistant
    // entries). Used to resolve RELATIVE tool-call file refs to absolute paths
    // before matching against recalled absolute paths, so a relative path opened
    // from one checkout is not misattributed to a recalled doc living under a
    // different checkout's absolute path (issue #723 review, blocking #7).
    const entryCwd = typeof entry['cwd'] === 'string' ? (entry['cwd'] as string) : undefined;

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
        extractRecalledDocIds(stdout, recalledSet, recalledMaps, docIdToPath, docIdToScope);
      }
    }

    const message = entry['message'] as Record<string, unknown> | undefined;
    if (message && typeof message['content'] === 'string') {
      const s = message['content'] as string;
      extractRecalledDocIdsFromComment(s, recalledSet);
      extractRecalledDocIds(s, recalledSet, recalledMaps, docIdToPath, docIdToScope);
    }
    if (!message || !Array.isArray(message['content'])) continue;

    // Subagent-internal messages (the teamai-recall Task subagent doing its own
    // Read/Grep to FIND candidates) are marked isSidechain. Their file opens are
    // retrieval, NOT the main conversation adopting a doc — counting them would
    // inflate upvotes (a recalled candidate the subagent merely inspected would
    // be credited even when the main agent never used it). Adoption evidence is
    // therefore collected only from the main (non-sidechain) conversation.
    const isSidechain = entry['isSidechain'] === true;

    // Collect ALL text blocks of THIS assistant message so a multipart final
    // reply is judged in full, not just its last fragment (issue #723 review).
    const messageTextParts: string[] = [];

    for (const block of message['content'] as Array<Record<string, unknown>>) {
      if (block['type'] === 'tool_result') {
        const tid = block['tool_use_id'] ?? block['toolUseId'];
        const tidStr = typeof tid === 'string' ? tid : undefined;
        // A failed tool call (is_error) proves nothing was read — do not let its
        // referenced tool_use count as adoption (issue #723 review).
        if (block['is_error'] === true || block['isError'] === true) {
          if (tidStr) failedToolUseIds.add(tidStr);
        }
        // Recall regions/markers in a tool_result: teamai's own recall output
        // (Task subagent / Bash `teamai recall`) is a trusted origin. But the
        // result of a plain file READER is just the CONTENT of a file the agent
        // opened — a user-authored .md could carry a FORGED recall region there,
        // so we buffer reader-result regions and only accept doc-ids also seen in
        // a trusted origin (issue #723 review). Non-reader results are trusted.
        // Buffered (not parsed inline) because reader ids are only fully known
        // after the whole transcript is scanned; the same buffer also feeds the
        // Glob/Grep matched-file harvest, which must run ONLY for reader results
        // (a Task summary result carries a recall region whose File: paths are
        // retrieval, not the main agent opening them — issue #723 review). The
        // entry's cwd is buffered too so a relative matched-file path can later be
        // resolved to absolute (issue #723 review, blocking #7).
        if (!isSidechain) deferredResultRegions.push({ id: tidStr, cwd: entryCwd, content: block['content'] });
      }

      // Tool-use evidence: a Read/Grep/Glob/Bash call in the MAIN conversation
      // that opens a recalled doc's file is proof the knowledge was adopted,
      // without any self-declaration. Sidechain tool calls are excluded above.
      // Keyed by tool_use id so a later failed result can revoke these refs, and
      // reader ids are tracked so their results are treated as untrusted content.
      if (block['type'] === 'tool_use') {
        const id = typeof block['id'] === 'string' ? (block['id'] as string) : undefined;
        const name = typeof block['name'] === 'string' ? block['name'].toLowerCase() : '';
        if (id && READ_LIKE_TOOLS.has(name)) readerToolUseIds.add(id);
        if (!isSidechain) {
          const refs = new Set<string>();
          collectToolFileRefs(block, refs);
          for (const r of refs) toolFileRefsById.push({ ref: r, id, cwd: entryCwd });
        }
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
      extractRecalledDocIds(text, recalledSet, recalledMaps, docIdToPath, docIdToScope);
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

  // Resolve adoption: a recalled doc is adopted when a tool call referenced its
  // recalled file path. Prefer a full-path match. Otherwise accept a match only
  // when one path is a path-segment SUFFIX of the other (e.g. the host logged a
  // relative `learnings/redis-timeout.md` for a recalled `/abs/learnings/
  // redis-timeout.md`, or a bare `redis-timeout.md`). This credits the same doc
  // reached via a different path root, but NOT an unrelated file that merely
  // shares a basename with a recalled doc in a different directory — e.g. some
  // other `setup.md` — which basename-only matching would have falsely credited.
  // Process buffered tool_result recall regions now that reader ids are known.
  //  - Non-reader results (teamai's Task/Bash recall output) are a TRUSTED
  //    origin → their doc-ids join recalledSet directly.
  //  - Reader results are the CONTENT of a file the agent opened; a forged recall
  //    region there must NOT manufacture a new doc-id, so we parse them into a
  //    provisional set and keep only ids already recalled from a trusted origin.
  for (const { id, cwd, content } of deferredResultRegions) {
    const isReader = id !== undefined && readerToolUseIds.has(id);
    if (isReader) {
      // Reader result = the CONTENT of a file the agent opened. A recall region
      // inside it is UNTRUSTED (a user-authored .md could forge one). Parse it
      // into FULLY THROWAWAY sinks — set AND path/scope/index maps — so a forged
      // region can neither add a new doc-id NOR poison the scope/path/index of a
      // LEGITIMATELY-recalled doc (first-occurrence-wins across the deferred
      // buffer would otherwise let a forged reader region beat a later trusted
      // Task result for the same id — issue #723 review). A genuinely-recalled
      // doc gets its scope/path from its trusted origin; adoption and all outputs
      // are gated to recalledSet, so dropping these writes loses nothing real.
      const sinkMaps: RecalledPathMaps = { full: new Map(), base: new Map() };
      extractRecalledDocIdsFromValue(content, new Set<string>(), sinkMaps, new Map(), new Map());
      //  - Glob/Grep report the files they MATCHED here (the input `path` is
      //    often just a directory), so harvest those .md paths as adoption
      //    evidence, tied to the tool_use id (a failed call's matches drop). The
      //    result entry's cwd is carried so a relative matched path can later be
      //    resolved to absolute (issue #723 review, blocking #7).
      for (const r of collectMdRefsFromValue(content)) toolFileRefsById.push({ ref: r, id, cwd });
    } else {
      // Non-reader result = teamai's own recall output (Task subagent / Bash
      // `teamai recall`): a TRUSTED origin, so doc-ids join recalledSet. We do
      // NOT harvest its File: paths as adoption — those are retrieval, not the
      // main agent opening the file (issue #723 review).
      extractRecalledDocIdsFromValue(content, recalledSet, recalledMaps, docIdToPath, docIdToScope);
    }
  }

  const adoptedSet = new Set<string>();
  for (const { ref, id, cwd } of toolFileRefsById) {
    // A failed/rejected tool call read nothing → its refs are not adoption.
    if (id !== undefined && failedToolUseIds.has(id)) continue;
    const norm = normalizePathKey(ref);
    // Resolve a RELATIVE ref against the entry's cwd before matching (issue
    // #723 review, blocking #7): recall injects ABSOLUTE paths, so a relative
    // tool path only matches the right recalled doc when joined to the checkout
    // it was opened from. When a cwd is available we resolve to an absolute path
    // and match ONLY on that exact full path — the basename+suffix fallback is
    // deliberately skipped, because re-applying it would re-credit the same
    // relative path opened from a DIFFERENT checkout (defeating the cwd
    // distinction). The suffix fallback below runs only when no cwd was present
    // (e.g. older transcripts), preserving the legacy relative-path behavior.
    if (cwd && !path.isAbsolute(norm)) {
      const resolved = normalizePathKey(path.resolve(cwd, ref));
      const byFullResolved = recalledFullPathToDocId.get(resolved);
      if (byFullResolved) adoptedSet.add(byFullResolved);
      continue;
    }
    // Exact full-path hit → credit directly.
    const byFull = recalledFullPathToDocId.get(norm);
    if (byFull) {
      adoptedSet.add(byFull);
      continue;
    }
    // Basename candidate → credit ONLY if it also passes the path-suffix guard
    // (≥2 trailing segments agree, unless the recalled path is a bare basename).
    const base = path.basename(norm);
    const byBase = recalledBasenameToDocId.get(normalizePathKey(base));
    if (!byBase) continue;
    const recalledPath = docIdToPath.get(byBase);
    if (recalledPath && pathSuffixMatches(norm, normalizePathKey(recalledPath))) {
      adoptedSet.add(byBase);
    }
  }
  // Guard: adoption can only credit docs actually recalled this session.
  const adoptedDocIds = [...adoptedSet].filter((id) => recalledSet.has(id));

  return {
    recalledDocIds: [...recalledSet],
    adoptedDocIds,
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

/**
 * Normalize a path for map keys: forward slashes, no trailing slash, and drop
 * `.` (current-dir) segments so a relative `./learnings/setup.md` compares equal
 * to `learnings/setup.md` (issue #723 review: the leading `.` otherwise became
 * an extra segment and broke the suffix match). Case is PRESERVED — lowercasing
 * would conflate distinct files on case-sensitive filesystems (`Setup.md` vs
 * `setup.md`). Indexing and lookup both go through this function, so the
 * comparison stays symmetric. Note: `..` segments are left intact — collapsing
 * them without a base directory would change which file a path denotes.
 */
function normalizePathKey(p: string): string {
  const slashed = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  // Rebuild from segments, dropping empty (`//`) and `.` segments. Preserve a
  // leading `/` so absolute paths stay absolute.
  const isAbsolute = slashed.startsWith('/');
  const segs = slashed.split('/').filter((s) => s !== '' && s !== '.');
  return (isAbsolute ? '/' : '') + segs.join('/');
}

/** Index a recalled file path under both its full-path and basename keys. */
/**
 * True when two normalized paths align on ENOUGH trailing path segments to be
 * confidently the same file. We require at least the last two segments (parent
 * dir + filename) to agree — so `learnings/b.md` matches `/x/learnings/b.md`,
 * but a BARE basename `b.md` does NOT match `/x/learnings/b.md` (issue #723
 * review: opening some other `setup.md` must not credit a recalled
 * `.../learnings/setup.md`). The only exception is when the recalled path is
 * itself a bare basename (nothing more specific was ever recorded), where the
 * filename is all the evidence that exists.
 */
function pathSuffixMatches(a: string, b: string): boolean {
  const sa = a.split('/').filter(Boolean);
  const sb = b.split('/').filter(Boolean);
  const n = Math.min(sa.length, sb.length);
  if (n === 0) return false;
  // Demand two matching trailing segments unless one side is a bare basename.
  const required = Math.min(2, Math.max(sa.length, sb.length));
  if (n < required) return false;
  for (let i = 1; i <= n; i++) {
    if (sa[sa.length - i] !== sb[sb.length - i]) return false;
  }
  return true;
}

/** Two lookup tables for recalled paths: exact full paths and basenames. */
interface RecalledPathMaps {
  full: Map<string, string>;
  base: Map<string, string>;
}

function indexRecalledPath(
  filePath: string,
  maps: RecalledPathMaps,
  docIdToPath?: Map<string, string>,
): void {
  const docId = path.basename(filePath).replace(/\.md$/i, '');
  if (!isValidDocId(docId)) return;
  maps.full.set(normalizePathKey(filePath), docId);
  maps.base.set(normalizePathKey(path.basename(filePath)), docId);
  // Record docId -> original (non-normalized) file path, first occurrence wins,
  // so the LLM-judge can read the doc's real content.
  if (docIdToPath && !docIdToPath.has(docId)) docIdToPath.set(docId, filePath);
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
  maps: RecalledPathMaps,
  docIdToPath?: Map<string, string>,
  docIdToScope?: Map<string, 'project' | 'user' | 'unknown'>,
): void {
  if (typeof value === 'string') {
    extractRecalledDocIdsFromComment(value, out);
    extractRecalledDocIds(value, out, maps, docIdToPath, docIdToScope);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractRecalledDocIdsFromValue(item, out, maps, docIdToPath, docIdToScope);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      extractRecalledDocIdsFromValue(item, out, maps, docIdToPath, docIdToScope);
    }
  }
}

function extractRecalledDocIds(
  text: string,
  out: Set<string>,
  maps: RecalledPathMaps,
  docIdToPath?: Map<string, string>,
  docIdToScope?: Map<string, 'project' | 'user' | 'unknown'>,
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
    // `[i/N] [type] Title ★votes [project]` — then a `File:` line. The `[user]`
    // / `[project]` tag is how we attribute the upvote to the right scope.
    let currentScope: 'project' | 'user' | 'unknown' = 'unknown';
    for (const rawLine of region.split('\n')) {
      const line = rawLine.trim();
      const header = line.match(/^\[\d+\/\d+\]/);
      if (header) {
        // Reset per hit, then read the trailing [project]/[user] tag if present.
        currentScope = 'unknown';
        const scopeTag = line.match(/\[(project|user)\]\s*$/);
        if (scopeTag) currentScope = scopeTag[1] as 'project' | 'user';
        continue;
      }
      const fileMatch = line.match(/^File:\s*(.+)$/);
      if (fileMatch) {
        const filePath = fileMatch[1].trim();
        const docId = path.basename(filePath).replace(/\.md$/i, '');
        if (isValidDocId(docId)) {
          out.add(docId);
          indexRecalledPath(filePath, maps, docIdToPath);
          if (docIdToScope && !docIdToScope.has(docId)) docIdToScope.set(docId, currentScope);
        }
      }
    }

    searchFrom = endIdx + RECALL_REGION_END.length;
  }
}

/**
 * Read-like tools whose file reference is evidence the agent CONSULTED a doc.
 * Adoption means the agent read/used the knowledge — so we count Read/Grep/Glob
 * and Bash (which can `cat`/`grep` a file), plus their common casing variants.
 * We deliberately EXCLUDE Write/Edit/MultiEdit/NotebookEdit: creating or
 * modifying a file that happens to sit at a recalled doc's path is not the agent
 * consulting team knowledge, and crediting it would be a false upvote.
 */
const READ_LIKE_TOOLS = new Set([
  'read', 'grep', 'glob', 'bash', 'notebookread', 'readfile', 'readmanyfiles',
]);

/**
 * Harvest `.md` path tokens from a decoded tool_result value (Glob's matched
 * file list, Grep's `path:line:` hits), recursing through nested blocks/strings.
 * Glob/Grep report the files they matched in the RESULT — the tool_use `input`
 * often only carries a directory `path` — so without this a Glob that matched a
 * recalled doc would never be credited (issue #723 review). Over-collection is
 * safe: every ref is later intersected with the recalled set and the caller ties
 * it to a tool_use id so a failed call's matches are dropped.
 *
 * Tightened (issue #723 review, blocking #6): previously this scanned the WHOLE
 * reader-result text with a free `*.md` regex, so Reading an unrelated notes.md
 * whose body merely MENTIONED `learnings/setup.md` credited setup.md. A reader
 * result's matched files appear as one-per-line path tokens — Glob lists bare
 * paths, Grep emits `path:line:...` — never as prose substrings. We now accept a
 * token ONLY when, after stripping surrounding quotes, an entire line is a file
 * path optionally followed by a grep `:line:` suffix. A `.md` mentioned mid-
 * sentence in file BODY content no longer matches.
 */
function collectMdRefsFromValue(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    // A line is a file path when, trimmed and quote-stripped, it is wholly a
    // `*.md` path optionally followed by `:line[:col]` (grep's path:line prefix).
    // Group 1 = the path; group 2 = the optional `:line...` remainder.
    const linePattern = /^([\w./~@+-]+\.md)(:\d+.*)?$/;
    for (const raw of value.split('\n')) {
      const stripped = raw.trim().replace(/^['"]|['"]$/g, '');
      const m = stripped.match(linePattern);
      if (m) out.add(m[1]);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMdRefsFromValue(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectMdRefsFromValue(item, out);
  }
  return out;
}

/**
 * Collect file-path references from a read-like tool_use block. Read/Grep/Glob
 * carry the path in structured input fields; Bash carries it inside the command
 * string. We over-collect paths on purpose — matches are later intersected with
 * the recalled file set, so unrelated paths cannot create false adoptions — but
 * we first gate on the tool NAME so a Write/Edit to a recalled path is not
 * mistaken for reading it.
 */
function collectToolFileRefs(block: Record<string, unknown>, out: Set<string>): void {
  const name = block['name'];
  if (typeof name !== 'string' || !READ_LIKE_TOOLS.has(name.toLowerCase())) return;

  const input = block['input'];
  if (!input || typeof input !== 'object') return;
  const inp = input as Record<string, unknown>;

  // Structured file fields used by Read/Grep/Glob (and common variants).
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    const v = inp[key];
    if (typeof v === 'string' && v.trim()) out.add(v.trim());
  }

  // Bash: pull out *.md tokens ONLY from sub-commands that actually READ a file,
  // and ONLY from their FILE-OPERAND tokens — never from a search pattern or a
  // trailing comment. A command like `echo setup.md` or `rm setup.md` mentions
  // the path but does not consult it; `grep 'learnings/setup.md' app.log` or
  // `cat other.txt # learnings/setup.md` names the doc in a pattern/comment but
  // reads a DIFFERENT file — crediting any of these would be a false upvote
  // (issue #723 review). So we split on shell separators, require the leading
  // word to be a known reader, then harvest .md tokens only from operand tokens.
  const command = inp['command'];
  if (typeof command === 'string') {
    for (const seg of splitShellSegments(command)) {
      const cmd = readerVerbOf(seg);
      if (!cmd) continue;
      for (const operand of fileOperands(seg, cmd)) {
        const mdPattern = /[\w./~@+-]*\.md\b/g;
        let m: RegExpExecArray | null;
        while ((m = mdPattern.exec(operand)) !== null) {
          const token = m[0].replace(/^['"]|['"]$/g, '').trim();
          if (token) out.add(token);
        }
      }
    }
  }
}

/**
 * grep-family readers take a SEARCH PATTERN as their first non-option operand,
 * so that operand is NOT a file and must be skipped when harvesting file tokens.
 * Plain readers (cat/head/…) treat every operand as a file.
 */
const PATTERN_FIRST_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);

/**
 * Options that CONSUME the next token as their value (so that following token is
 * an option-argument, e.g. a grep pattern or context count, not a file). Covers
 * the common grep/rg flags whose value could otherwise look like a path.
 */
const VALUE_OPTIONS = new Set([
  '-e', '--regexp', '-f', '--file', '-m', '--max-count',
  '-A', '--after-context', '-B', '--before-context', '-C', '--context',
  '--include', '--exclude', '--exclude-dir', '-g', '--glob',
]);

/**
 * Extract the FILE-OPERAND tokens of a reader segment: strip the leading verb,
 * drop flags and their consumed values, stop at a `#` comment, and (for
 * pattern-first readers like grep) drop the first bare operand, which is the
 * search pattern rather than a file.
 *
 * Quote-aware tokenization (issue #723 review, blocking #8): words are split
 * with `splitShellWords`, which keeps a quoted string (`"x | cat foo.md"`) as a
 * SINGLE token, so a separator/path inside quotes never leaks out as a separate
 * operand. Without this, `grep "x | cat learnings/setup.md" app.log` would
 * splinter the quoted pattern into bare words and `learnings/setup.md` would be
 * harvested as a file operand (a false upvote) even though it lives inside the
 * grep PATTERN.
 */
function fileOperands(segment: string, cmd: string): string[] {
  const words = splitShellWords(segment).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const operands: string[] = [];
  let sawVerb = false;
  let patternPending = PATTERN_FIRST_READERS.has(cmd);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    if (!sawVerb) { sawVerb = true; continue; } // skip the leading verb (path already basename-matched by readerVerbOf)
    if (w.startsWith('#')) break; // trailing comment — nothing after it is read
    if (w === '--') continue;
    // Output redirection: the token AFTER `>`/`>>`/`2>`/`&>` (or a glued
    // `>file`) is WRITTEN, not read — crediting it would be a false upvote
    // (issue #723 review: `cat other.md > learnings/setup.md` must not credit
    // setup.md). Skip the operator and its target; a glued form carries its own
    // target so only that token is dropped.
    const redir = w.match(/^(?:[0-9]*|&)?>>?&?$/); // >, >>, 1>, 2>, &>, >&
    if (redir) { i++; continue; } // separate target token → skip it too
    if (/^(?:[0-9]*|&)?>>?/.test(w)) continue; // glued `>out.md` / `2>err.md` → drop this token only
    if (w.startsWith('-') && w.length > 1) {
      // An option; if it consumes a value, skip the next token too.
      const flag = w.includes('=') ? w.slice(0, w.indexOf('=')) : w;
      // A pattern-supplying option (-e/--regexp/-f/--file) means the search
      // pattern arrived via the flag, so the next bare operand is a FILE, not
      // the pattern — clear patternPending so it is not wrongly dropped.
      if (PATTERN_OPTIONS.has(flag)) patternPending = false;
      if (!w.includes('=') && VALUE_OPTIONS.has(flag)) i++;
      continue;
    }
    // Input redirection `< file`: the target IS read, so let it fall through as
    // an operand (drop only the bare `<` operator token).
    if (w === '<') continue;
    if (patternPending) { patternPending = false; continue; } // first bare operand = grep pattern
    operands.push(w);
  }
  return operands;
}

/** Options that SUPPLY the search pattern to a pattern-first reader, so the
 *  first bare operand after them is a file rather than the pattern. */
const PATTERN_OPTIONS = new Set(['-e', '--regexp', '-f', '--file']);

/**
 * Shell command words that UNAMBIGUOUSLY read file contents (evidence of
 * consulting a doc). Deliberately conservative: we EXCLUDE verbs that commonly
 * mutate or merely reference a file — `sed`/`awk` (can edit in place or redirect),
 * `open` (launches an editor), `diff`/`sort`/`uniq`/`column` (not "consulting"
 * one doc) — because over-crediting is a false upvote (issue #723 review).
 */
const FILE_READER_COMMANDS = new Set([
  'cat', 'bat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg',
  'ag', 'ack', 'view', 'nl', 'od', 'strings', 'wc', 'cut',
]);

/**
 * Split a shell command on separators (`;`, `&&`, `||`, `|`, newline) so each
 * sub-command can be classified independently — `echo x.md && cat y.md` must
 * count only `y.md`.
 *
 * Quote-aware (issue #723 review, blocking #8): a `|`/`;`/`&&`/`||`/newline that
 * sits INSIDE a single- or double-quoted string is NOT a separator — e.g.
 * `grep "x | cat learnings/setup.md" app.log` must stay one segment so the
 * quoted `|` does not synthesize a fake `cat learnings/setup.md` sub-command and
 * credit a doc the agent never opened. A small char-walk state machine tracks
 * single/double quote state and honors backslash escapes inside double quotes.
 * Returns trimmed non-empty segments.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let singleQ = false; // inside a single-quoted string
  let doubleQ = false; // inside a double-quoted string
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (singleQ) {
      // Inside single quotes: only a closing single-quote ends the region; no
      // escape processing (POSIX single quotes are literal).
      if (ch === "'") singleQ = false;
      current += ch;
      continue;
    }
    if (doubleQ) {
      // Inside double quotes: backslash escapes the NEXT char (kept literally);
      // a closing double-quote ends the region. Separators are literal here.
      if (ch === '\\' && i + 1 < command.length) {
        current += ch + command[i + 1];
        i++;
        continue;
      }
      if (ch === '"') doubleQ = false;
      current += ch;
      continue;
    }
    // Outside any quote: separators cut a segment. Handle two-char operators
    // (||, &&) by peeking ahead so they don't split twice.
    if (ch === "'" || ch === '"') {
      if (ch === "'") singleQ = true; else doubleQ = true;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '||' || two === '&&') {
      segments.push(current);
      current = '';
      i++; // consume the second char
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * If a shell segment's leading command word is a known file reader, return the
 * normalized verb (basename, so `/usr/bin/cat` → `cat`); otherwise null. A
 * `cat foo.md` reads it; `echo foo.md`, `rm foo.md`, `ls`, `git add foo.md` do
 * not, so those yield null and create no adoption evidence (issue #723 review).
 */
function readerVerbOf(segment: string): string | null {
  // Skip leading env-var assignments (FOO=bar cat file) to reach the real verb.
  const words = segment.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (words.length === 0) return null;
  // Strip a leading path (e.g. /usr/bin/cat → cat).
  const cmd = path.basename(words[0]);
  return FILE_READER_COMMANDS.has(cmd) ? cmd : null;
}

/**
 * Quote-aware word tokenizer for a SINGLE shell segment (issue #723 review,
 * blocking #8): splits on unquoted whitespace, keeping a single- or
 * double-quoted string as ONE token (quote characters retained, so downstream
 * `.md` extraction strips them with the existing `replace(/^['"]|['"]$/g)`).
 * This prevents a quoted grep PATTERN like `"x | cat learnings/setup.md"` from
 * splintering into bare words whose `.md` fragment is then harvested as a file
 * operand. Backslash escapes the next char inside double quotes (POSIX-ish).
 */
function splitShellWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let singleQ = false;
  let doubleQ = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (singleQ) {
      current += ch;
      if (ch === "'") singleQ = false;
      continue;
    }
    if (doubleQ) {
      if (ch === '\\' && i + 1 < segment.length) {
        current += ch + segment[i + 1];
        i++;
        continue;
      }
      current += ch;
      if (ch === '"') doubleQ = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inWord = true;
      if (ch === "'") singleQ = true; else doubleQ = true;
      current += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (inWord) { words.push(current); current = ''; inWord = false; }
      continue;
    }
    inWord = true;
    current += ch;
  }
  if (inWord) words.push(current);
  return words;
}

