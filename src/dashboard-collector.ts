import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { log } from './utils/logger.js';
import { deriveSessionId } from './utils/session-id.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { ensureDir } from './utils/fs.js';
import { resolveMonitorPid } from './pid-monitor.js';
import { normalizeToolName } from './utils/tool-names.js';
import { redactWithEnv } from './utils/redact.js';
import {
  DASHBOARD_EVENTS_PATH,
  DASHBOARD_EVENTS_DIR,
  DASHBOARD_COMPACTION_THRESHOLD,
  DASHBOARD_IDLE_TIMEOUT_MS,
  DASHBOARD_STALE_TIMEOUT_MS,
  DASHBOARD_STOPPED_DISPLAY_MS,
  CORRECTION_WINDOW_MS,
  CORRECTION_KEYWORDS,
  INTERVENTION_SCAN_MAX_BYTES,
  TRANSCRIPT_INTERRUPT_PREFIX,
  TRANSCRIPT_SYSTEM_PREFIXES,
  TRANSCRIPT_REJECT_MARKERS,
  emptyTokenUsage,
  addTokenUsage,
  type DashboardEvent,
  type DashboardEventType,
  type DashboardSession,
  type DashboardSessionStatus,
  type TokenUsage,
  type TokenSnapshotScope,
  type SessionMetrics,
  type RequestCostMetrics,
} from './types.js';
import { getUserHome } from './utils/home.js';
import { estimateClaudeRequest } from './model-pricing.js';

// ─── Event collection data flow ─────────────────────────
//
//  Hook STDIN JSON (varies by event type)
//      │
//      ▼
//  parseHookEvent(raw, tool)
//      │ extract: session_id / cwd / tool_name / prompt
//      ▼
//  DashboardEvent
//      │
//      ▼
//  appendEvent(event) → events.jsonl
//

// ─── STDIN parsing ──────────────────────────────────────

/** Read STDIN fully. Returns empty string if STDIN is a TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// ─── Transcript reading ─────────────────────────────────

/** Maximum bytes to read from the end of a transcript file. */
const TRANSCRIPT_TAIL_BYTES = 10240;
/** Maximum characters for stoppedOutput. */
const STOPPED_OUTPUT_MAX_CHARS = 500;

/**
 * Read the last assistant message from a Claude Code transcript file.
 * Uses tail-read (last 10KB) to avoid loading the entire file into memory.
 * Returns empty string on any error (file missing, permission denied, etc.).
 */
export async function readLastAssistantOutput(transcriptPath: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(transcriptPath);
    const fileSize = stat.size;
    if (fileSize === 0) return '';

    const readSize = Math.min(fileSize, TRANSCRIPT_TAIL_BYTES);
    const offset = Math.max(0, fileSize - readSize);

    const fh = await fs.promises.open(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fh.read(buffer, 0, readSize, offset);
      const tail = buffer.toString('utf-8');

      // Parse JSONL lines from the tail, find the last assistant message
      const lines = tail.split('\n').filter(l => l.trim());
      let lastAssistantText = '';

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Claude Code transcript format: {type: "assistant", message: {content: [{type: "text", text: "..."}]}}
          if (entry.type === 'assistant' && entry.message?.content) {
            const textParts = (entry.message.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text);
            if (textParts.length > 0) {
              lastAssistantText = textParts.join('\n');
            }
          }
        } catch {
          // Skip malformed lines (expected when tail starts mid-line)
        }
      }

      // Scrub secrets before this text is persisted to events.jsonl and rendered
      // in the dashboard. Redact first, then slice, so a placeholder (not a raw
      // token fragment) is what lands near the length boundary.
      return redactWithEnv(lastAssistantText).slice(0, STOPPED_OUTPUT_MAX_CHARS);
    } finally {
      await fh.close();
    }
  } catch (e) {
    log.warn(`dashboard: failed to read transcript: ${(e as Error).message}`);
    return '';
  }
}

/** Result of a full-transcript scan at session Stop: cumulative, idempotent snapshot. */
export interface TranscriptScanResult {
  interrupt: number;
  toolReject: number;
  /**
   * Cumulative count of genuine tool failures (tool_result with is_error=true that
   * is NOT a user permission rejection). Signals the AI struggled with a tool and
   * had to retry — a strong "this session hit a real snag" indicator for contribute
   * scoring. Distinct from toolReject (human deny).
   */
  toolError: number;
  tokens: TokenUsage;
  /** Scope of a Codex cumulative snapshot; absent for other transcript formats. */
  tokenScope?: TokenSnapshotScope;
  /**
   * Cumulative count of genuine human prompt turns in the transcript. Sourced here
   * (not from compactable prompt_submit events) so the reported baseline stays
   * monotonic across compaction + same-session resume — same guarantee as `tokens`.
   */
  prompts: number;
  /** Cumulative API-equivalent request cost for recognized Claude models. */
  requestMetrics?: RequestCostMetrics;
}

/**
 * Scan a full transcript once at Stop time and collect cumulative, idempotent
 * snapshots of:
 * - interrupt:  user message whose text starts with "[Request interrupted by user"
 * - toolReject: tool_result with is_error=true marked as a user rejection
 * - tokens:     Claude usage summed across deduplicated assistant messages, or the
 *               latest cumulative Codex token snapshot. Modern
 *               `token_usage_record` is session-scoped; legacy
 *               `event_msg/token_count` is scoped to one transcript/rollout file.
 * - prompts:    genuine human prompt turns (user entries with real text, excluding
 *               interrupts, tool_results, and meta/sidechain entries).
 *
 * Uses a streaming line reader so large transcripts don't load fully into memory.
 * Returns zero counts on any error (file missing, too large, permission denied).
 *
 * Set `opts.frictionOnly` to true for low-latency foreground callers (e.g.
 * contribute-check) that only need friction signals. On the CodeBuddy index.json
 * path this skips the token-flush retry loop — friction comes from a single blob
 * scan that completes before the retry, so no token wait is required. It also
 * skips the Codex post-Stop flush wait. The Claude JSONL path is a single streaming
 * scan with no retry, so the flag is a no-op there.
 */
export async function scanTranscriptStop(
  transcriptPath: string,
  opts?: { frictionOnly?: boolean; tool?: string },
): Promise<TranscriptScanResult> {
  // CodeBuddy persists its transcript as a single `index.json` document (a JSON
  // object with `requests[].usage` + `messages[]`), NOT the JSONL schema used by
  // Claude and Codex. Detect and parse that shape separately.
  if (path.basename(transcriptPath) === 'index.json') {
    const cb = await scanCodebuddyIndex(transcriptPath, opts?.frictionOnly ?? false);
    if (cb) return cb;
  }

  const initial = await scanJsonlTranscriptOnce(transcriptPath);
  if (opts?.frictionOnly || !isCodexTool(opts?.tool)) return initial.result;

  // Codex can append the final cumulative usage record shortly after firing Stop.
  // Keep the full-scan friction/prompt result, but poll only a small file tail for
  // a newer token snapshot so a previous turn's non-zero total is not mistaken for
  // the just-finished turn. This is bounded to ~1.75s and never loads the whole file
  // repeatedly.
  const flushedSnapshot = await waitForCodexUsageFlush(transcriptPath, initial.codexSnapshot);
  return flushedSnapshot
    ? { ...initial.result, tokens: flushedSnapshot.tokens, tokenScope: flushedSnapshot.scope }
    : initial.result;
}

interface CodexTokenSnapshot {
  tokens: TokenUsage;
  scope: TokenSnapshotScope;
}

interface JsonlTranscriptScan {
  result: TranscriptScanResult;
  /** Preferred cumulative Codex snapshot encountered, if this is a Codex transcript. */
  codexSnapshot: CodexTokenSnapshot | null;
}

/** Scan the Claude/Codex JSONL transcript once. */
async function scanJsonlTranscriptOnce(transcriptPath: string): Promise<JsonlTranscriptScan> {
  let interrupt = 0;
  let toolReject = 0;
  let toolError = 0;
  let prompts = 0;
  const tokens = emptyTokenUsage();
  let requestMetrics: RequestCostMetrics | undefined;
  let codexSessionSnapshot: CodexTokenSnapshot | null = null;
  let codexTranscriptSnapshot: CodexTokenSnapshot | null = null;
  // Dedup assistant usage per message (one turn spans many JSONL lines that repeat
  // the same usage). Prefer message.id; fall back to the top-level requestId.
  const countedUsageKeys = new Set<string>();

  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size === 0) {
      return { result: { interrupt, toolReject, toolError, tokens, prompts }, codexSnapshot: null };
    }
    if (stat.size > INTERVENTION_SCAN_MAX_BYTES) {
      log.warn(`dashboard: transcript too large to scan (${stat.size} bytes)`);
      return { result: { interrupt, toolReject, toolError, tokens, prompts }, codexSnapshot: null };
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(transcriptPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      // Cheap pre-filter: Claude uses user/assistant records; modern Codex emits
      // token_usage_record and legacy Codex emits event_msg/token_count records.
      if (
        !trimmed || (
          !trimmed.includes('"user"') &&
          !trimmed.includes('"assistant"') &&
          !trimmed.includes('"token_usage_record"') &&
          !trimmed.includes('"token_count"')
        )
      ) continue;

      let entry: {
        type?: string;
        isMeta?: unknown;
        isSidechain?: unknown;
        requestId?: unknown;
        payload?: unknown;
        message?: { content?: unknown; id?: unknown; model?: unknown; usage?: Record<string, unknown> };
      };
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const codexUsage = parseCodexCumulativeUsage(entry);
      if (codexUsage) {
        // Replace within the matching scope. A session-scoped thread record is
        // authoritative when both formats are present; the legacy transcript-scoped
        // counter must not be added to it.
        if (codexUsage.scope === 'session') codexSessionSnapshot = codexUsage;
        else codexTranscriptSnapshot = codexUsage;
        continue;
      }

      if (entry.type === 'assistant') {
        const usage = entry.message?.usage;
        const dedupKey = typeof entry.message?.id === 'string'
          ? entry.message.id
          : typeof entry.requestId === 'string'
            ? entry.requestId
            : undefined;
        if (usage && dedupKey && !countedUsageKeys.has(dedupKey)) {
          countedUsageKeys.add(dedupKey);
          const requestTokens: TokenUsage = {
            input: toNum(usage.input_tokens),
            output: toNum(usage.output_tokens),
            cacheRead: toNum(usage.cache_read_input_tokens),
            cacheCreation: toNum(usage.cache_creation_input_tokens),
          };
          tokens.input += requestTokens.input;
          tokens.output += requestTokens.output;
          tokens.cacheRead += requestTokens.cacheRead;
          tokens.cacheCreation += requestTokens.cacheCreation;
          if (typeof entry.message?.model === 'string') {
            const priced = estimateClaudeRequest(entry.message.model, requestTokens);
            if (priced) {
              requestMetrics = {
                pricedRequests: (requestMetrics?.pricedRequests ?? 0) + 1,
                costMicros: (requestMetrics?.costMicros ?? 0) + priced.costMicros,
                cacheReadTokens: (requestMetrics?.cacheReadTokens ?? 0) + priced.cacheReadTokens,
                cacheEligibleInputTokens: (requestMetrics?.cacheEligibleInputTokens ?? 0) + priced.cacheEligibleInputTokens,
                priceVersion: priced.priceVersion,
              };
            }
          }
        }
        continue;
      }

      if (entry.type !== 'user') continue;

      const isMeta = entry.isMeta === true || entry.isSidechain === true;
      const content = entry.message?.content;

      // Plain-string user content = a genuine human prompt (older transcript shape).
      if (typeof content === 'string') {
        const trimContent = content.trim();
        if (
          !isMeta &&
          trimContent &&
          !trimContent.startsWith(TRANSCRIPT_INTERRUPT_PREFIX) &&
          !TRANSCRIPT_SYSTEM_PREFIXES.some((p) => trimContent.startsWith(p))
        ) {
          prompts++;
        }
        continue;
      }
      if (!Array.isArray(content)) continue;

      let hasHumanText = false;
      for (const item of content as Array<Record<string, unknown>>) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          const txt = item.text.trim();
          if (item.text.startsWith(TRANSCRIPT_INTERRUPT_PREFIX)) {
            interrupt++;
          } else if (txt && !TRANSCRIPT_SYSTEM_PREFIXES.some((p) => txt.startsWith(p))) {
            hasHumanText = true;
          }
        } else if (item?.type === 'tool_result' && item.is_error === true) {
          const text = typeof item.content === 'string'
            ? item.content
            : Array.isArray(item.content)
              ? (item.content as Array<{ text?: string }>)
                .map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ')
              : '';
          if (TRANSCRIPT_REJECT_MARKERS.some((m) => text.includes(m))) {
            toolReject++;
          } else {
            // is_error=true but not a permission deny → a genuine tool failure
            // the AI had to work around (bad args, command error, etc.).
            toolError++;
          }
        }
      }
      // One human turn per user entry (tool_result-only entries have no human text).
      if (hasHumanText && !isMeta) prompts++;
    }
  } catch (e) {
    log.warn(`dashboard: failed to scan transcript: ${(e as Error).message}`);
  }

  const codexSnapshot = codexSessionSnapshot ?? codexTranscriptSnapshot;
  const result: TranscriptScanResult = {
    interrupt,
    toolReject,
    toolError,
    tokens: codexSnapshot?.tokens ?? tokens,
    prompts,
    ...(requestMetrics ? { requestMetrics } : {}),
    ...(codexSnapshot ? { tokenScope: codexSnapshot.scope } : {}),
  };
  return { result, codexSnapshot };
}

/** Narrow an unknown JSON value to an object record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Convert Codex's inclusive input token count into TeamAI's disjoint buckets.
 * Codex input_tokens includes cached/cache-write tokens; output_tokens already
 * includes reasoning output, so neither subset may be added a second time.
 */
function codexUsageToTokenUsage(usage: Record<string, unknown>): TokenUsage {
  const inclusiveInput = toNum(usage.input_tokens);
  const cacheRead = toNum(usage.cached_input_tokens);
  const cacheCreation = toNum(usage.cache_write_input_tokens);
  return {
    input: Math.max(0, inclusiveInput - cacheRead - cacheCreation),
    output: toNum(usage.output_tokens),
    cacheRead,
    cacheCreation,
  };
}

/** Parse one cumulative Codex usage record (modern or legacy), if present. */
function parseCodexCumulativeUsage(entry: { type?: string; payload?: unknown }): CodexTokenSnapshot | null {
  const payload = asRecord(entry.payload);

  if (entry.type === 'token_usage_record') {
    const usage = asRecord(payload?.thread_token_usage);
    return usage ? { tokens: codexUsageToTokenUsage(usage), scope: 'session' } : null;
  }

  if (entry.type === 'event_msg' && payload?.type === 'token_count') {
    const usage = asRecord(asRecord(payload.info)?.total_token_usage);
    return usage ? { tokens: codexUsageToTokenUsage(usage), scope: 'transcript' } : null;
  }

  return null;
}

const CODEX_USAGE_TAIL_BYTES = 256 * 1024;
const CODEX_USAGE_MAX_ATTEMPTS = 8;
const CODEX_USAGE_RETRY_MS = 250;

function isCodexTool(tool: string | undefined): boolean {
  return typeof tool === 'string' && tool.toLowerCase().includes('codex');
}

function codexSnapshotEquals(a: CodexTokenSnapshot | null, b: CodexTokenSnapshot): boolean {
  return a !== null && a.scope === b.scope
    && a.tokens.input === b.tokens.input && a.tokens.output === b.tokens.output
    && a.tokens.cacheRead === b.tokens.cacheRead
    && a.tokens.cacheCreation === b.tokens.cacheCreation;
}

/** Prefer session-scoped records; otherwise keep the latest record in the same scope. */
function preferCodexSnapshot(
  current: CodexTokenSnapshot | null,
  observed: CodexTokenSnapshot,
): CodexTokenSnapshot {
  if (current?.scope === 'session' && observed.scope === 'transcript') return current;
  return observed;
}

/** Read only the transcript tail and return its latest cumulative Codex snapshot. */
async function readLatestCodexUsageFromTail(transcriptPath: string): Promise<CodexTokenSnapshot | null> {
  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size === 0) return null;
    const readSize = Math.min(stat.size, CODEX_USAGE_TAIL_BYTES);
    const offset = stat.size - readSize;
    const fh = await fs.promises.open(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fh.read(buffer, 0, readSize, offset);
      const lines = buffer.toString('utf-8').split('\n');
      // When reading a tail slice, the first line may start in the middle of JSON.
      if (offset > 0) lines.shift();
      let latestSession: CodexTokenSnapshot | null = null;
      let latestTranscript: CodexTokenSnapshot | null = null;
      for (const line of lines) {
        if (!line.includes('"token_usage_record"') && !line.includes('"token_count"')) continue;
        try {
          const parsed = JSON.parse(line) as { type?: string; payload?: unknown };
          const snapshot = parseCodexCumulativeUsage(parsed);
          if (snapshot?.scope === 'session') latestSession = snapshot;
          else if (snapshot) latestTranscript = snapshot;
        } catch {
          // The final line can be mid-write; a later retry will see it completed.
        }
      }
      return latestSession ?? latestTranscript;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** Wait for Codex's post-Stop cumulative token record without rescanning the file. */
async function waitForCodexUsageFlush(
  transcriptPath: string,
  initial: CodexTokenSnapshot | null,
): Promise<CodexTokenSnapshot | null> {
  let latest = initial;
  for (let attempt = 1; attempt < CODEX_USAGE_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, CODEX_USAGE_RETRY_MS));
    const observed = await readLatestCodexUsageFromTail(transcriptPath);
    if (!observed) continue;
    latest = preferCodexSnapshot(latest, observed);

    // A changed cumulative snapshot is the record for the turn that just stopped.
    // For a first-turn session, the transition from no record to non-zero is enough.
    if (!codexSnapshotEquals(initial, latest)
      && (initial !== null || totalTokenCount(latest.tokens) > 0)) {
      return latest;
    }
  }
  return latest;
}

/**
 * Read a CodeBuddy `index.json` transcript once. CodeBuddy's schema differs from
 * Claude Code:
 *
 *   {
 *     "messages": [{ "role": "user" | "assistant" | "tool", ... }],
 *     "requests": [{ "usage": { "inputTokens", "outputTokens", "totalTokens" } }]
 *   }
 *
 * - tokens:  summed across `requests[].usage` (same per-turn accumulation model as
 *            the Claude scan, so re-sent context is counted each request). CodeBuddy
 *            reports no cache-read/creation split at the request level, so those map
 *            to 0 and `input + output` matches CodeBuddy's own `totalTokens`.
 * - prompts: count of `messages[]` entries with role === 'user' (human turns).
 *
 * Returns null when the file is missing, too large, unparseable (e.g. read mid-write),
 * or not a CodeBuddy index document.
 */
async function readCodebuddyIndexOnce(
  transcriptPath: string,
): Promise<TranscriptScanResult | null> {
  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size === 0 || stat.size > INTERVENTION_SCAN_MAX_BYTES) return null;

    const content = await fs.promises.readFile(transcriptPath, 'utf-8');
    const data = JSON.parse(content) as {
      messages?: Array<{ role?: unknown }>;
      requests?: Array<{ usage?: Record<string, unknown> }>;
    };
    if (!data || !Array.isArray(data.requests)) return null;

    const tokens = emptyTokenUsage();
    for (const req of data.requests) {
      const usage = req?.usage;
      if (!usage) continue;
      tokens.input += toNum(usage.inputTokens);
      tokens.output += toNum(usage.outputTokens);
    }

    const prompts = Array.isArray(data.messages)
      ? data.messages.filter((m) => m?.role === 'user').length
      : 0;

    // CodeBuddy index.json carries no interrupt marker (kept 0). toolReject /
    // toolError are extracted by scanCodebuddyIndex from messages/ blobs, so this
    // function returns 0 for both and lets the outer layer overwrite them.
    return { interrupt: 0, toolReject: 0, toolError: 0, tokens, prompts };
  } catch (e) {
    log.warn(`dashboard: failed to scan CodeBuddy index: ${(e as Error).message}`);
    return null;
  }
}

/** Total token count across all four buckets. */
function totalTokenCount(t: TokenUsage): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

/** Retry budget for waiting on CodeBuddy's post-Stop token-usage flush. */
const CODEBUDDY_USAGE_MAX_ATTEMPTS = 8;
const CODEBUDDY_USAGE_RETRY_MS = 250;
/** Cap on CodeBuddy message blobs scanned for friction, to bound Stop-hook IO. */
const CODEBUDDY_BLOB_MAX_COUNT = 2000;
/** User-rejection marker CodeBuddy writes into a cancelled tool's result.errorMessage. */
const CODEBUDDY_REJECT_MARKER = 'User rejected this command';

/**
 * Scan CodeBuddy message blobs for tool-reject and tool-error friction signals.
 *
 * `index.json` is only a skeleton (tokens + prompt list) and omits tool results,
 * so the friction signals must be read from the sibling `messages/*.json` blobs,
 * where each blob is one message turn.
 *
 * Detection criteria (verified against real CodeBuddy transcripts):
 * - toolReject: a blob with `role === 'assistant'` whose `extra` field is a JSON
 *   *string* (parsed a second time) yielding `extra.toolStatus` as
 *   `{ [callId]: entry }`. An entry with `status === 'cancelled'` and
 *   `result.errorMessage` containing {@link CODEBUDDY_REJECT_MARKER} counts as one
 *   rejection. That marker is CodeBuddy's user-rejection-only fixed string, which
 *   naturally excludes system auto-cancels (UNFINISHED TOOL / MalformedToolArgs)
 *   and interrupt residue.
 * - toolError: a blob with `role === 'tool'` whose `message` field is a JSON
 *   *string* (parsed a second time) yielding `message.content` as an array of
 *   `{ type: 'tool-result', toolCallId, isError, result }`. An element with
 *   `isError === true` counts as one error. Executed tools and rejected tools both
 *   carry `isError === false`, so only genuine execution errors are counted — this
 *   aligns with Claude's "is_error=true and not a reject" semantics.
 *
 * Counts are de-duplicated per `callId` via Sets, since the same callId may appear
 * in multiple blobs. The function never throws: any single-blob read/parse/shape
 * failure is skipped, yielding a best-effort count. Blob count is capped at
 * {@link CODEBUDDY_BLOB_MAX_COUNT} because this runs on the Stop hook, which
 * has a fixed timeout budget — a pathologically large directory must not
 * stall it.
 */
async function scanCodebuddyBlobs(
  messagesDir: string,
): Promise<{ toolReject: number; toolError: number }> {
  let names: string[];
  try {
    names = await fs.promises.readdir(messagesDir);
  } catch {
    return { toolReject: 0, toolError: 0 };
  }

  const blobPaths = names
    .filter((n) => n.endsWith('.json'))
    // Truncation is by lexicographic filename order (not chronological); real
    // sessions have far fewer message turns than this cap, so correctness is
    // unaffected — it only bounds Stop-hook IO.
    .sort()
    .slice(0, CODEBUDDY_BLOB_MAX_COUNT)
    .map((n) => path.join(messagesDir, n));

  const rejectedCallIds = new Set<string>();
  const erroredCallIds = new Set<string>();

  for (const blobPath of blobPaths) {
    try {
      const stat = await fs.promises.stat(blobPath);
      if (stat.size === 0 || stat.size > INTERVENTION_SCAN_MAX_BYTES) continue;

      const raw = await fs.promises.readFile(blobPath, 'utf-8');
      const blob = JSON.parse(raw) as {
        role?: unknown;
        extra?: unknown;
        message?: unknown;
      };

      if (blob.role === 'assistant') {
        if (typeof blob.extra !== 'string') continue;
        let extra: unknown;
        try {
          extra = JSON.parse(blob.extra);
        } catch {
          continue;
        }
        const toolStatus = (extra as { toolStatus?: unknown } | null)?.toolStatus;
        if (!toolStatus || typeof toolStatus !== 'object') continue;
        for (const [callId, entry] of Object.entries(
          toolStatus as Record<string, unknown>,
        )) {
          if (!entry || typeof entry !== 'object') continue;
          const e = entry as {
            status?: unknown;
            result?: { errorMessage?: unknown } | null;
          };
          if (
            e.status === 'cancelled' &&
            typeof e.result?.errorMessage === 'string' &&
            e.result.errorMessage.includes(CODEBUDDY_REJECT_MARKER)
          ) {
            rejectedCallIds.add(callId);
          }
        }
      } else if (blob.role === 'tool') {
        if (typeof blob.message !== 'string') continue;
        let message: unknown;
        try {
          message = JSON.parse(blob.message);
        } catch {
          continue;
        }
        const content = (message as { content?: unknown } | null)?.content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const i = item as {
            type?: unknown;
            toolCallId?: unknown;
            isError?: unknown;
          };
          if (
            i.type === 'tool-result' &&
            i.isError === true &&
            typeof i.toolCallId === 'string'
          ) {
            erroredCallIds.add(i.toolCallId);
          }
        }
      }
    } catch {
      continue;
    }
  }

  return { toolReject: rejectedCallIds.size, toolError: erroredCallIds.size };
}

/**
 * Scan a CodeBuddy `index.json` for a cumulative, idempotent token + prompt
 * snapshot, with a bounded retry.
 *
 * CodeBuddy flushes per-request token usage into `index.json` *shortly after* it
 * fires the Stop hook, so the first read frequently sees the human `messages`
 * already written (prompts are captured) but `requests[].usage` still zero. Without
 * a retry, single-turn / last-turn sessions would permanently record 0 tokens. We
 * re-read (up to ~1.75s, well within the 60s hook timeout) until usage appears.
 * This retry path is only exercised by background dashboard callers with a lax hook
 * timeout; foreground low-latency callers (e.g. contribute-check) pass `frictionOnly`
 * (see {@link scanTranscriptStop}) and skip the retry loop entirely.
 *
 * Friction signals (toolReject / toolError) are extracted once from the sibling
 * `messages/` blob directory (see {@link scanCodebuddyBlobs}) and merged into the
 * result. Blob contents don't change during the token-flush retry window, so they
 * are scanned a single time before the loop to avoid amplifying IO. `interrupt`
 * stays 0 — CodeBuddy has no on-disk marker for it.
 *
 * Returns null only when the file never parses as a CodeBuddy index — the caller
 * then falls back to the Claude JSONL scanner.
 */
async function scanCodebuddyIndex(
  transcriptPath: string,
  frictionOnly = false,
): Promise<TranscriptScanResult | null> {
  const messagesDir = path.join(path.dirname(transcriptPath), 'messages');
  const friction = await scanCodebuddyBlobs(messagesDir);

  // Friction-only callers (e.g. the foreground contribute-check Stop hook) don't
  // need token usage, so skip the token-flush retry loop entirely — friction is
  // already complete from the single blob scan above. Saves up to ~1.75s of
  // foreground hook budget.
  if (frictionOnly) {
    const once = await readCodebuddyIndexOnce(transcriptPath);
    if (once) {
      return { ...once, toolReject: friction.toolReject, toolError: friction.toolError };
    }
    // index.json unreadable, but we still have friction from the blobs.
    return {
      interrupt: 0,
      toolReject: friction.toolReject,
      toolError: friction.toolError,
      tokens: emptyTokenUsage(),
      prompts: 0,
    };
  }

  let last: TranscriptScanResult | null = null;
  for (let attempt = 0; attempt < CODEBUDDY_USAGE_MAX_ATTEMPTS; attempt++) {
    const result = await readCodebuddyIndexOnce(transcriptPath);
    if (result) {
      last = result;
      // Usage has been flushed — the snapshot is complete, stop waiting.
      if (totalTokenCount(result.tokens) > 0) {
        return { ...result, toolReject: friction.toolReject, toolError: friction.toolError };
      }
    }
    if (attempt < CODEBUDDY_USAGE_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, CODEBUDDY_USAGE_RETRY_MS));
    }
  }
  // Never observed non-zero usage: return the best (zero-token) snapshot we have
  // (with friction merged in), or null so the caller falls back to the Claude
  // JSONL scanner.
  if (last) {
    return { ...last, toolReject: friction.toolReject, toolError: friction.toolError };
  }
  return last;
}

/** Coerce an unknown usage field to a non-negative finite number (0 otherwise). */
function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Backward-compatible intervention-only scan. Delegates to {@link scanTranscriptStop}.
 */
export async function countInterventions(
  transcriptPath: string,
): Promise<{ interrupt: number; toolReject: number; toolError: number }> {
  const { interrupt, toolReject, toolError } = await scanTranscriptStop(transcriptPath);
  return { interrupt, toolReject, toolError };
}

/** True when a prompt looks like a course-correction (vs. a fresh task). */
function isCorrectionPrompt(text?: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CORRECTION_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * Map hook event names to dashboard event types.
 * Supports Claude Code (PascalCase), Cursor and CodeBuddy (camelCase) formats.
 */
function mapEventType(hookEventName: string): DashboardEventType | null {
  switch (hookEventName) {
    case 'SessionStart':
    case 'sessionStart':
      return 'session_start';
    case 'PostToolUse':
    case 'postToolUse':
      return 'tool_use';
    case 'UserPromptSubmit':
    case 'userPromptSubmit':
    case 'beforeSubmitPrompt':
      return 'prompt_submit';
    case 'Stop':
    case 'stop':
      return 'stop';
    default:
      return null;
  }
}

/**
 * Parse a hook STDIN JSON payload into a DashboardEvent.
 * Returns null if the payload is invalid or irrelevant.
 * For stop events, reads the transcript file to capture AI output.
 */
export async function parseHookEvent(
  raw: string,
  tool: string,
): Promise<DashboardEvent | null> {
  if (!raw.trim()) return null;

  let hookData: Record<string, unknown>;
  try {
    hookData = JSON.parse(raw);
  } catch {
    log.error('dashboard-collector: failed to parse STDIN JSON');
    return null;
  }

  // Determine event type from hook_event_name field
  const hookEventName = typeof hookData.hook_event_name === 'string'
    ? hookData.hook_event_name
    : '';
  const eventType = mapEventType(hookEventName);
  if (!eventType) {
    log.debug(`dashboard-collector: unknown hook event: ${hookEventName}`);
    return null;
  }

  const sessionId = deriveSessionId(hookData, { includeCwd: true });
  const cwd = resolveHookCwd(hookData);

  const event: DashboardEvent = {
    type: eventType,
    timestamp: new Date().toISOString(),
    sessionId,
    tool,
    cwd,
  };

  // Extract tool name from PostToolUse (normalize IDE-style names)
  if (eventType === 'tool_use' && typeof hookData.tool_name === 'string') {
    event.toolName = normalizeToolName(hookData.tool_name);
  }

  // Resolve AI tool PID for liveness monitoring on session start
  if (eventType === 'session_start') {
    const ppid = process.ppid ?? process.pid;
    if (ppid > 1) {
      try {
        event.monitorPid = resolveMonitorPid(ppid);
      } catch {
        // PID resolution failed — fall back to ppid
        event.monitorPid = ppid;
      }
    }
  }

  // Extract prompt summary from UserPromptSubmit
  if (eventType === 'prompt_submit' && typeof hookData.prompt === 'string') {
    // Keep first 200 chars of the prompt as summary
    event.promptSummary = hookData.prompt.slice(0, 200);
  }

  // Extract transcript path, AI output and intervention counts from Stop event
  if (eventType === 'stop' && typeof hookData.transcript_path === 'string') {
    event.transcriptPath = hookData.transcript_path;
    const output = await readLastAssistantOutput(hookData.transcript_path);
    if (output) {
      event.stoppedOutput = output;
    }
    // Full-transcript snapshot of interrupt/tool_reject counts + token usage +
    // human prompt count (all idempotent, sourced from the non-compactable transcript).
    const scan = await scanTranscriptStop(hookData.transcript_path, { tool });
    if (scan.interrupt > 0 || scan.toolReject > 0 || scan.toolError > 0) {
      event.interventions = {
        interrupt: scan.interrupt,
        toolReject: scan.toolReject,
        toolError: scan.toolError,
      };
    }
    if (scan.tokens.input > 0 || scan.tokens.output > 0
      || scan.tokens.cacheRead > 0 || scan.tokens.cacheCreation > 0) {
      event.tokens = scan.tokens;
      if (scan.tokenScope) event.tokenScope = scan.tokenScope;
    }
    if (scan.prompts > 0) {
      event.prompts = scan.prompts;
    }
    if (scan.requestMetrics) {
      event.requestMetrics = scan.requestMetrics;
    }
  }

  return event;
}

// ─── JSONL persistence ──────────────────────────────────

/** Get events path (evaluated at call time). */
function getEventsPath(): string {
  return path.join(getUserHome(), '.teamai', 'dashboard', 'events.jsonl');
}

/**
 * Append a DashboardEvent to the events JSONL file.
 * Silently fails on I/O errors to avoid disrupting the AI session.
 */
export async function appendEvent(event: DashboardEvent): Promise<void> {
  try {
    const eventsPath = getEventsPath();
    await ensureDir(path.dirname(eventsPath));
    const line = JSON.stringify(event) + '\n';
    await fs.promises.appendFile(eventsPath, line, 'utf-8');
    const detail = event.toolName
      ? ` [tool=${event.toolName}]`
      : event.promptSummary
        ? ` [prompt=${event.promptSummary.slice(0, 60)}]`
        : '';
    log.debug(`dashboard: recorded ${event.type} for session ${event.sessionId.slice(0, 16)}${detail}`);
  } catch (e) {
    log.error(`dashboard: failed to write event: ${(e as Error).message}`);
  }
}

/**
 * Read all events from the JSONL file. Skips corrupted lines.
 */
export async function readEvents(eventsPath?: string): Promise<DashboardEvent[]> {
  const filePath = eventsPath ?? getEventsPath();
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const events: DashboardEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as DashboardEvent;
        if (parsed.type && parsed.sessionId && parsed.timestamp) {
          events.push(parsed);
        }
      } catch {
        // Skip corrupted lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

// ─── Session state rebuild ──────────────────────────────
//
//  events.jsonl (append-only)
//      │
//      ▼
//  rebuildSessions(events)
//      │ fold events into session map
//      │ apply idle/stale timeouts
//      ▼
//  DashboardSession[]
//

/**
 * Rebuild current session states from a list of events.
 * This is the core "event sourcing" logic:
 * - session_start → create session, record monitorPid
 * - tool_use → update lastActivity + lastTool, mark running
 * - prompt_submit → capture prompt, mark running
 * - stop → mark as waiting_for_input (LLM finished, user still in session)
 * - process_exit → mark as stopped (process truly exited)
 * Then apply timeouts: idle after 5 min, remove stale after 30 min.
 * Stopped sessions are kept for 30 seconds before removal.
 */
export function rebuildSessions(events: DashboardEvent[]): DashboardSession[] {
  const sessions = new Map<string, DashboardSession>();
  const now = Date.now();

  for (const event of events) {
    let session = sessions.get(event.sessionId);

    if (!session) {
      session = {
        sessionId: event.sessionId,
        tool: event.tool,
        status: 'running',
        cwd: event.cwd ?? '',
        promptSummary: '',
        lastActivity: event.timestamp,
        startedAt: event.timestamp,
        lastTool: '',
        prompts: [],
        stoppedOutput: '',
        stoppedAt: '',
        interventions: { interrupt: 0, toolReject: 0, correction: 0 },
        interventionCount: 0,
        promptCount: 0,
        tokens: emptyTokenUsage(),
      };
      sessions.set(event.sessionId, session);
    }

    // Update common fields
    session.lastActivity = event.timestamp;
    if (event.cwd) session.cwd = event.cwd;

    switch (event.type) {
      case 'session_start':
        session.status = 'running';
        session.startedAt = event.timestamp;
        if (event.monitorPid) session.monitorPid = event.monitorPid;
        break;
      case 'tool_use':
        session.status = 'running';
        if (event.toolName) session.lastTool = event.toolName;
        break;
      case 'prompt_submit':
        session.status = 'running';
        // Capture the first prompt as summary
        if (!session.promptSummary && event.promptSummary) {
          session.promptSummary = event.promptSummary;
        }
        // Collect all prompts
        if (event.promptSummary) {
          session.prompts.push(event.promptSummary);
        }
        break;
      case 'stop':
        // Stop = LLM finished responding, but the user is still in the session.
        // Mark as waiting_for_input instead of stopped. The session will return
        // to 'running' when the next prompt_submit or tool_use arrives.
        session.status = 'waiting_for_input';
        if (event.stoppedOutput) {
          session.stoppedOutput = event.stoppedOutput;
        }
        break;
      case 'process_exit':
        // The AI tool process has truly exited (detected by PID liveness monitor).
        // This is the real "session ended" signal.
        session.status = 'stopped';
        session.stoppedAt = event.timestamp;
        break;
    }
  }

  // Fill per-session metrics (single source of truth: aggregate fold)
  const metricsMap = aggregateSessionMetrics(events);
  for (const session of sessions.values()) {
    const m = metricsMap.get(session.sessionId);
    if (m) {
      session.interventions = { interrupt: m.interrupt, toolReject: m.toolReject, correction: m.correction };
      session.interventionCount = m.interrupt + m.toolReject + m.correction;
      session.promptCount = m.prompts;
      session.tokens = m.tokens;
    }
  }

  // Apply timeouts
  const result: DashboardSession[] = [];
  for (const session of sessions.values()) {
    const lastActivityMs = new Date(session.lastActivity).getTime();
    const elapsed = now - lastActivityMs;

    if (session.status === 'stopped') {
      // Keep stopped sessions for 30 seconds, then remove
      const stoppedAtMs = session.stoppedAt
        ? new Date(session.stoppedAt).getTime()
        : lastActivityMs;
      const stoppedElapsed = now - stoppedAtMs;
      if (stoppedElapsed > DASHBOARD_STOPPED_DISPLAY_MS) continue;
      result.push(session);
      continue;
    }

    // Remove stale sessions (> 30 min)
    if (elapsed > DASHBOARD_STALE_TIMEOUT_MS) continue;

    // Mark idle sessions (> 5 min)
    if (elapsed > DASHBOARD_IDLE_TIMEOUT_MS) {
      session.status = 'idle';
    }

    result.push(session);
  }

  // Sort: active sessions first, stopped last; within each group by total runtime descending
  result.sort((a, b) => {
    if (a.status === 'stopped' && b.status !== 'stopped') return 1;
    if (a.status !== 'stopped' && b.status === 'stopped') return -1;
    // Sort by total runtime descending (longest-running first) for stable card positions
    const sortNow = Date.now();
    const aEnd = a.stoppedAt ? new Date(a.stoppedAt).getTime() : sortNow;
    const bEnd = b.stoppedAt ? new Date(b.stoppedAt).getTime() : sortNow;
    const aRuntime = aEnd - new Date(a.startedAt).getTime();
    const bRuntime = bEnd - new Date(b.startedAt).getTime();
    return bRuntime - aRuntime;
  });
  return result;
}

interface TimedTokenSnapshot {
  timestamp: string;
  tokens: TokenUsage;
}

/**
 * Keep the chronologically latest snapshot. Stop handlers run in the background,
 * so append order can differ from hook/event order when two scans overlap.
 */
function setLatestTokenSnapshot(
  snapshots: Map<string, TimedTokenSnapshot>,
  key: string,
  event: DashboardEvent,
): void {
  if (!event.tokens) return;
  const current = snapshots.get(key);
  const candidateTime = Date.parse(event.timestamp);
  const currentTime = current ? Date.parse(current.timestamp) : Number.NaN;
  if (!current || !Number.isFinite(candidateTime) || !Number.isFinite(currentTime)
    || candidateTime >= currentTime) {
    snapshots.set(key, { timestamp: event.timestamp, tokens: event.tokens });
  }
}

/**
 * Aggregate per-session metrics from raw events (no timeout filtering).
 *
 * - interrupt / toolReject: taken from the latest Stop event's snapshot.
 * - tokens: unscoped and session-scoped snapshots use latest-wins. Legacy Codex
 *   transcript-scoped snapshots use latest-wins per transcript path, then sum the
 *   distinct rollout segments for the logical session.
 * - correction: a prompt_submit arriving within CORRECTION_WINDOW_MS of a Stop AND
 *   matching a correction keyword. Each Stop is consumed by the next prompt only once.
 * - prompts: total number of prompt_submit events (human conversation turns).
 *
 * Used both by rebuildSessions (live dashboard) and by the team-stats reporter.
 */
export function aggregateSessionMetrics(
  events: DashboardEvent[],
): Map<string, SessionMetrics> {
  const map = new Map<string, SessionMetrics>();
  const lastStopAt = new Map<string, number>();
  // Two prompt-count sources, kept separate then reconciled with max():
  // - submitCount: live prompt_submit events (real-time, but compactable).
  // - stopPrompts: latest Stop transcript snapshot (compaction/resume-proof).
  const submitCount = new Map<string, number>();
  const stopPrompts = new Map<string, number>();
  const unscopedTokens = new Map<string, TimedTokenSnapshot>();
  const sessionTokens = new Map<string, TimedTokenSnapshot>();
  const transcriptTokens = new Map<string, Map<string, TimedTokenSnapshot>>();

  for (const event of events) {
    let m = map.get(event.sessionId);
    if (!m) {
      m = { interrupt: 0, toolReject: 0, correction: 0, prompts: 0, tokens: emptyTokenUsage() };
      map.set(event.sessionId, m);
    }

    if (event.type === 'stop') {
      if (event.interventions) {
        m.interrupt = event.interventions.interrupt;
        m.toolReject = event.interventions.toolReject;
      }
      if (event.tokens) {
        if (event.tokenScope === 'session') {
          setLatestTokenSnapshot(sessionTokens, event.sessionId, event);
        } else if (event.tokenScope === 'transcript' && event.transcriptPath) {
          let segments = transcriptTokens.get(event.sessionId);
          if (!segments) {
            segments = new Map<string, TimedTokenSnapshot>();
            transcriptTokens.set(event.sessionId, segments);
          }
          // A rollout's counter is cumulative within that file. Repeated Stop scans
          // replace the same segment; a resumed rollout has a distinct path and adds
          // one new segment to the logical session total.
          setLatestTokenSnapshot(segments, event.transcriptPath, event);
        } else {
          // Claude, CodeBuddy, and pre-existing events retain latest-Stop semantics.
          setLatestTokenSnapshot(unscopedTokens, event.sessionId, event);
        }
      }
      if (typeof event.prompts === 'number') {
        stopPrompts.set(event.sessionId, event.prompts);
      }
      lastStopAt.set(event.sessionId, new Date(event.timestamp).getTime());
    } else if (event.type === 'prompt_submit') {
      submitCount.set(event.sessionId, (submitCount.get(event.sessionId) ?? 0) + 1);
      const stopAt = lastStopAt.get(event.sessionId);
      if (stopAt !== undefined) {
        const gap = new Date(event.timestamp).getTime() - stopAt;
        if (gap >= 0 && gap <= CORRECTION_WINDOW_MS && isCorrectionPrompt(event.promptSummary)) {
          m.correction++;
        }
        // Each stop is consumed once — a later prompt is a new task, not a correction.
        lastStopAt.delete(event.sessionId);
      }
    }
  }

  // Reconcile prompt count: the Stop transcript snapshot is the durable baseline
  // (survives compaction + resume); live submit events cover the period before the
  // first Stop. max() keeps the count monotonic across both.
  for (const [sid, m] of map) {
    const sessionSnapshot = sessionTokens.get(sid);
    const segments = transcriptTokens.get(sid);
    if (sessionSnapshot) {
      // The newer thread-level counter already spans rollout files.
      m.tokens = { ...sessionSnapshot.tokens };
    } else if (segments && segments.size > 0) {
      let total = emptyTokenUsage();
      for (const segment of segments.values()) total = addTokenUsage(total, segment.tokens);
      m.tokens = total;
    } else {
      const unscoped = unscopedTokens.get(sid);
      if (unscoped) m.tokens = { ...unscoped.tokens };
    }
    m.prompts = Math.max(submitCount.get(sid) ?? 0, stopPrompts.get(sid) ?? 0);
  }

  return map;
}

/**
 * Backward-compatible intervention-only view. Delegates to {@link aggregateSessionMetrics}.
 */
export function aggregateSessionInterventions(
  events: DashboardEvent[],
): Map<string, { interrupt: number; toolReject: number; correction: number }> {
  const out = new Map<string, { interrupt: number; toolReject: number; correction: number }>();
  for (const [sid, m] of aggregateSessionMetrics(events)) {
    out.set(sid, { interrupt: m.interrupt, toolReject: m.toolReject, correction: m.correction });
  }
  return out;
}

// ─── JSONL compaction ───────────────────────────────────

/**
 * Compact events.jsonl by keeping only events for active sessions.
 * Active = not stopped and last activity within STALE_TIMEOUT.
 * Called when file exceeds COMPACTION_THRESHOLD lines.
 */
export async function compactEvents(eventsPath?: string): Promise<void> {
  const filePath = eventsPath ?? getEventsPath();
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length < DASHBOARD_COMPACTION_THRESHOLD) return;

    const events = await readEvents(filePath);
    const activeSessions = rebuildSessions(events);
    const activeIds = new Set(activeSessions.map(s => s.sessionId));

    // Keep only events for active sessions
    const kept = events.filter(e => activeIds.has(e.sessionId));
    const compacted = kept.map(e => JSON.stringify(e)).join('\n') + '\n';

    // Atomic write: write to temp, then rename
    const tmpPath = filePath + '.tmp';
    await fs.promises.writeFile(tmpPath, compacted, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);

    log.debug(`dashboard: compacted ${lines.length} → ${kept.length} events`);
  } catch (e) {
    log.error(`dashboard: compaction failed: ${(e as Error).message}`);
  }
}

// ─── CLI entry point ────────────────────────────────────

/**
 * Handle `teamai dashboard-report --stdin --tool <name>`.
 * Called by dashboard hooks in Claude Code / other AI tools.
 */
export async function dashboardReport(toolArg?: string): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    log.debug('dashboard-report: no STDIN data');
    return;
  }

  const event = await parseHookEvent(raw, toolArg ?? 'claude');
  if (!event) return;

  await appendEvent(event);

  // Trigger compaction check (non-blocking)
  compactEvents().catch(() => {});
}
