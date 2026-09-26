import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { log } from './utils/logger.js';
import { deriveDispatchSessionId } from './utils/session-id.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { ensureDir } from './utils/fs.js';
import { repoKeys, repoLabel } from './utils/repo-attribution.js';
import { isProcessAlive, resolveMonitorPid } from './pid-monitor.js';
import { normalizeToolName } from './utils/tool-names.js';
import { redactWithEnv } from './utils/redact.js';
import { acquireLock, releaseLock } from './update.js';
import {
  DASHBOARD_COMPACTION_THRESHOLD,
  DASHBOARD_IDLE_TIMEOUT_MS,
  DASHBOARD_STALE_TIMEOUT_MS,
  DASHBOARD_STOPPED_DISPLAY_MS,
  CORRECTION_WINDOW_MS,
  CORRECTION_KEYWORDS,
  INTERVENTION_SCAN_MAX_BYTES,
  TRANSCRIPT_INTERRUPT_PREFIX,
  TRANSCRIPT_SYSTEM_PREFIXES,
  stripInjectedPrompt,
  TRANSCRIPT_REJECT_MARKERS,
  COPILOT_TOOL_ID,
  getCopilotHome,
  getDataHome,
  emptyTokenUsage,
  addTokenUsage,
  type DashboardEvent,
  type DashboardEventType,
  type DashboardSession,
  type TokenUsage,
  type TokenSnapshotScope,
  type SessionMetrics,
  type RequestCostMetrics,
  type LocalConfig,
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
//      │ dataHomeKey = key of the data home of the scope the hook resolved
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
  /** Priced request details retained locally; no prompt or response content. */
  requestRecords?: LocalRequestRecord[];
}

export interface LocalRequestRecord {
  id: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costMicros: number;
  priceVersion: string;
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
  opts?: { frictionOnly?: boolean; tool?: string; modelAliases?: Record<string, string> },
): Promise<TranscriptScanResult> {
  // CodeBuddy persists its transcript as a single `index.json` document (a JSON
  // object with `requests[].usage` + `messages[]`), NOT the JSONL schema used by
  // Claude and Codex. Detect and parse that shape separately.
  if (path.basename(transcriptPath) === 'index.json') {
    const cb = await scanCodebuddyIndex(transcriptPath, opts?.frictionOnly ?? false);
    if (cb) return cb;
  }

  const initial = await scanJsonlTranscriptOnce(transcriptPath, opts?.modelAliases);
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
/**
 * Whether a Claude transcript entry is a human turn, what the Stop scan counts
 * as a prompt: plain-string user content, or user content with text that is
 * neither an interrupt marker nor a system injection; never meta or sidechain.
 * One human turn per user entry (tool_result-only entries have no human text).
 */
export function isHumanPromptEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || !('type' in entry) || entry.type !== 'user') return false;
  if (('isMeta' in entry && entry.isMeta === true) || ('isSidechain' in entry && entry.isSidechain === true)) return false;
  const message = 'message' in entry && entry.message && typeof entry.message === 'object' ? entry.message : undefined;
  const content: unknown = message && 'content' in message ? message.content : undefined;
  if (typeof content === 'string') {
    const text = content.trim();
    return !!text && !text.startsWith(TRANSCRIPT_INTERRUPT_PREFIX) && !TRANSCRIPT_SYSTEM_PREFIXES.some((p) => text.startsWith(p));
  }
  if (!Array.isArray(content)) return false;
  return content.some((item: unknown) => {
    if (!item || typeof item !== 'object' || !('type' in item) || item.type !== 'text' || !('text' in item)) return false;
    if (typeof item.text !== 'string' || item.text.startsWith(TRANSCRIPT_INTERRUPT_PREFIX)) return false;
    const text = item.text.trim();
    return !!text && !TRANSCRIPT_SYSTEM_PREFIXES.some((p) => text.startsWith(p));
  });
}

async function scanJsonlTranscriptOnce(transcriptPath: string, modelAliases?: Record<string, string>): Promise<JsonlTranscriptScan> {
  let interrupt = 0;
  let toolReject = 0;
  let toolError = 0;
  let prompts = 0;
  const tokens = emptyTokenUsage();
  let requestMetrics: RequestCostMetrics | undefined;
  const requestRecords: LocalRequestRecord[] = [];
  let codexSessionSnapshot: CodexTokenSnapshot | null = null;
  let codexTranscriptSnapshot: CodexTokenSnapshot | null = null;
  // Dedup assistant usage per message (one turn spans many JSONL lines that repeat
  // the same usage). Prefer message.id; fall back to the top-level requestId.
  const countedUsageKeys = new Set<string>();
  const historicalRequests = await readLocalRequestRecords();

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
        timestamp?: unknown;
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
            const id = createHash('sha256').update(`${transcriptPath}\0${dedupKey}`).digest('hex');
            const historical = historicalRequests.get(id);
            const priced = historical
              ? {
                costMicros: historical.costMicros,
                cacheReadTokens: historical.cacheReadTokens,
                cacheEligibleInputTokens: historical.inputTokens + historical.cacheReadTokens + historical.cacheCreationTokens,
                priceVersion: historical.priceVersion,
              }
              : estimateClaudeRequest(entry.message.model, requestTokens, modelAliases);
            if (priced) {
              requestMetrics = {
                pricedRequests: (requestMetrics?.pricedRequests ?? 0) + 1,
                costMicros: (requestMetrics?.costMicros ?? 0) + priced.costMicros,
                cacheReadTokens: (requestMetrics?.cacheReadTokens ?? 0) + priced.cacheReadTokens,
                cacheEligibleInputTokens: (requestMetrics?.cacheEligibleInputTokens ?? 0) + priced.cacheEligibleInputTokens,
                priceVersion: priced.priceVersion,
              };
              const timestamp = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))
                ? new Date(entry.timestamp).toISOString()
                : '';
              requestRecords.push({
                id,
                timestamp,
                model: entry.message.model,
                inputTokens: requestTokens.input,
                outputTokens: requestTokens.output,
                cacheReadTokens: requestTokens.cacheRead,
                cacheCreationTokens: requestTokens.cacheCreation,
                costMicros: priced.costMicros,
                priceVersion: priced.priceVersion,
              });
            }
          }
        }
        continue;
      }

      if (entry.type !== 'user') continue;

      if (isHumanPromptEntry(entry)) prompts++;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      for (const item of content as Array<Record<string, unknown>>) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          if (item.text.startsWith(TRANSCRIPT_INTERRUPT_PREFIX)) interrupt++;
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
    ...(requestRecords.length ? { requestRecords } : {}),
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

const COPILOT_USAGE_TAIL_BYTES = 256 * 1024;
const COPILOT_RUN_SCAN_BYTES = 8 * 1024 * 1024;
const COPILOT_USAGE_MAX_ATTEMPTS = 8;
const COPILOT_USAGE_RETRY_MS = 250;
const COPILOT_SHUTDOWN_EVENT = 'session.shutdown';
const COPILOT_SESSION_STATE_DIR = 'session-state';
const COPILOT_SESSION_EVENTS_FILE = 'events.jsonl';
const COPILOT_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface CopilotUsageObservation {
  shutdownObserved: boolean;
  shutdownOffset?: number;
  tokens?: TokenUsage;
}

function copilotUsageEquals(
  first: CopilotUsageObservation,
  second: CopilotUsageObservation,
): boolean {
  if (first.shutdownObserved !== second.shutdownObserved) return false;
  if (!first.tokens || !second.tokens) return first.tokens === second.tokens;
  return first.tokens.input === second.tokens.input
    && first.tokens.output === second.tokens.output
    && first.tokens.cacheRead === second.tokens.cacheRead
    && first.tokens.cacheCreation === second.tokens.cacheCreation;
}

/** Parse only Copilot's final aggregate token counters from a shutdown record. */
function parseCopilotShutdown(entry: unknown): CopilotUsageObservation {
  const record = asRecord(entry);
  if (record?.type !== COPILOT_SHUTDOWN_EVENT) return { shutdownObserved: false };

  const details = asRecord(asRecord(record.data)?.tokenDetails);
  if (!details) return { shutdownObserved: true };
  const tokenCount = (bucket: string): number | undefined => {
    const value = asRecord(details[bucket])?.tokenCount;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  };
  const input = tokenCount('input');
  const output = tokenCount('output');
  const cacheRead = tokenCount('cache_read');
  const cacheCreation = tokenCount('cache_write');
  if ([input, output, cacheRead, cacheCreation].every((value) => value === undefined)) {
    return { shutdownObserved: true };
  }
  return {
    shutdownObserved: true,
    tokens: {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheCreation: cacheCreation ?? 0,
    },
  };
}

/** Read a bounded tail without retaining any prompt, output, or request fields. */
async function readLatestCopilotUsageFromTail(
  transcriptPath: string,
): Promise<CopilotUsageObservation> {
  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size === 0) return { shutdownObserved: false };
    const readSize = Math.min(stat.size, COPILOT_USAGE_TAIL_BYTES);
    const offset = stat.size - readSize;
    const fh = await fs.promises.open(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fh.read(buffer, 0, readSize, offset);
      let lineStart = 0;
      if (offset > 0) {
        const partialLineEnd = buffer.indexOf('\n');
        if (partialLineEnd < 0) return { shutdownObserved: false };
        lineStart = partialLineEnd + 1;
      }
      let latest: CopilotUsageObservation = { shutdownObserved: false };
      while (lineStart < buffer.length) {
        const newline = buffer.indexOf('\n', lineStart);
        const lineEnd = newline < 0 ? buffer.length : newline;
        const line = buffer.subarray(lineStart, lineEnd).toString('utf-8');
        if (line.includes(`"${COPILOT_SHUTDOWN_EVENT}"`)) {
          try {
            const observed = parseCopilotShutdown(JSON.parse(line));
            if (observed.shutdownObserved) {
              latest = { ...observed, shutdownOffset: offset + lineEnd };
            }
          } catch {
            // The last line may still be in flight; the bounded retry sees it later.
          }
        }
        if (newline < 0) break;
        lineStart = newline + 1;
      }
      return latest;
    } finally {
      await fh.close();
    }
  } catch {
    log.debug('dashboard: failed to read Copilot usage tail');
    return { shutdownObserved: false };
  }
}

/** Wait briefly because Copilot can append session.shutdown after SessionEnd. */
async function waitForCopilotShutdownUsage(
  transcriptPath: string,
  initial: CopilotUsageObservation,
): Promise<CopilotUsageObservation> {
  const isCurrent = (observed: CopilotUsageObservation): boolean => {
    if (!observed.shutdownObserved) return false;
    // Legacy sessions have no run marker; only a newly observed record is safe.
    return !initial.shutdownObserved
      || observed.shutdownOffset !== initial.shutdownOffset
      || !copilotUsageEquals(initial, observed);
  };
  if (isCurrent(initial)) return initial;
  for (let attempt = 1; attempt < COPILOT_USAGE_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, COPILOT_USAGE_RETRY_MS));
    const observed = await readLatestCopilotUsageFromTail(transcriptPath);
    if (isCurrent(observed)) return observed;
  }
  return { shutdownObserved: false };
}

interface CopilotRunMarker {
  id: string;
  offset: number;
}

/** Recover a marker written after SessionStart from a bounded private-log tail. */
async function findCopilotRunMarkerAfter(
  transcriptPath: string,
  startOffset: number,
  startedAt: number,
  endedAt: number,
  useProviderTime: boolean,
): Promise<CopilotRunMarker | undefined> {
  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (startOffset > stat.size || stat.size - startOffset > COPILOT_RUN_SCAN_BYTES) {
      return undefined;
    }
    const readSize = stat.size - startOffset;
    const offset = startOffset;
    const fh = await fs.promises.open(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fh.read(buffer, 0, readSize, offset);
      let lineStart = 0;
      let selected: CopilotRunMarker | undefined;
      while (lineStart < buffer.length) {
        const newline = buffer.indexOf('\n', lineStart);
        const lineEnd = newline < 0 ? buffer.length : newline;
        const line = buffer.subarray(lineStart, lineEnd).toString('utf-8');
        if (line.includes('"session.start"') || line.includes('"session.resume"')) {
          try {
            const record = asRecord(JSON.parse(line));
            const markerTime = record?.timestamp;
            const time = typeof markerTime === 'string' || typeof markerTime === 'number'
              ? new Date(markerTime).getTime() : NaN;
            if ((record?.type === 'session.start' || record?.type === 'session.resume')
              && typeof record.id === 'string'
              && offset + lineStart >= startOffset
              && (!useProviderTime || (Number.isFinite(time)
                && time >= startedAt && time <= endedAt))) {
              selected = { id: record.id, offset: offset + lineStart };
            }
          } catch {
            // Partial records provide no safe run linkage.
          }
        }
        if (newline < 0) break;
        lineStart = newline + 1;
      }
      return selected;
    } finally {
      await fh.close();
    }
  } catch {
    log.debug('dashboard: failed to recover Copilot run marker');
    return undefined;
  }
}

/** Follow Copilot event parent IDs from the current run marker, discarding content. */
async function readCopilotUsageForRun(
  transcriptPath: string,
  marker: CopilotRunMarker,
): Promise<CopilotUsageObservation> {
  const descendants = new Set<string>([marker.id]);
  let latest: CopilotUsageObservation = { shutdownObserved: false };
  try {
    const stat = await fs.promises.stat(transcriptPath);
    // Large transcript bodies are private and may be arbitrarily long. Missing
    // totals are safer than rereading an unbounded log on every retry.
    if (stat.size - marker.offset > COPILOT_RUN_SCAN_BYTES) return latest;
    const stream = fs.createReadStream(transcriptPath, {
      start: marker.offset, encoding: 'utf-8',
    });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let record: Record<string, unknown> | null;
        try {
          record = asRecord(JSON.parse(line));
        } catch {
          continue;
        }
        if (!record || typeof record.id !== 'string') continue;
        if ((record.type === 'session.start' || record.type === 'session.resume')
          && record.id !== marker.id) break;
        if (typeof record.parentId === 'string' && descendants.has(record.parentId)) {
          descendants.add(record.id);
        }
        if (record.type === COPILOT_SHUTDOWN_EVENT && descendants.has(record.id)) {
          latest = parseCopilotShutdown(record);
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  } catch {
    log.debug('dashboard: failed to read Copilot run lineage');
  }
  return latest;
}

async function waitForCopilotRunUsage(
  transcriptPath: string,
  marker: CopilotRunMarker,
): Promise<CopilotUsageObservation> {
  for (let attempt = 0; attempt < COPILOT_USAGE_MAX_ATTEMPTS; attempt++) {
    const observed = await readCopilotUsageForRun(transcriptPath, marker);
    if (observed.tokens) return observed;
    if (attempt < COPILOT_USAGE_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, COPILOT_USAGE_RETRY_MS));
    }
  }
  return { shutdownObserved: false };
}

/** Resolve Copilot's local event log without accepting path traversal via sessionId. */
/** Copilot's own session log for `sessionId`, derived from the ID alone (TeamAI stores no path of it, #666). */
export function resolveCopilotUsageTranscript(
  sessionId: string,
): string | null {
  if (!COPILOT_SESSION_ID_RE.test(sessionId) || sessionId === '.' || sessionId === '..') return null;
  return path.join(
    getCopilotHome(),
    COPILOT_SESSION_STATE_DIR,
    sessionId,
    COPILOT_SESSION_EVENTS_FILE,
  );
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

/** Scripts that do not separate words with spaces: substring matching is correct there. */
const UNSPACED_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Match a keyword as a whole word: no letter, digit or underscore may touch either
 * end, so `undo` does not fire on "segundo" or on the identifier "test_undo".
 */
function wordBoundaryPattern(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u');
}

/** True when `lower` contains `keyword`, whole-word for spaced scripts, substring otherwise. */
function containsKeyword(lower: string, keyword: string): boolean {
  const k = keyword.trim().normalize('NFC').toLowerCase();
  if (!k) return false;
  if (UNSPACED_SCRIPT_RE.test(k)) return lower.includes(k);
  return wordBoundaryPattern(k).test(lower);
}

/**
 * True when a prompt looks like a course-correction (vs. a fresh task).
 * `extraKeywords` are the team's `sharing.intervention.correctionKeywords`.
 */
function isCorrectionPrompt(text?: string, extraKeywords: readonly string[] = []): boolean {
  if (!text) return false;
  const lower = text.normalize('NFC').toLowerCase();
  return [...CORRECTION_KEYWORDS, ...extraKeywords].some((k) => containsKeyword(lower, k));
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
    case 'SessionEnd':
    case 'sessionEnd':
      return 'session_end';
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

export interface ParseHookEventOptions {
  /** Team keywords (`sharing.intervention.correctionKeywords`) merged with the built-in list. */
  correctionKeywords?: readonly string[];
  /** Per-machine gateway model-alias → known Claude model name, for cost/cache estimation. */
  modelAliases?: Record<string, string>;
}

/**
 * Parse a hook STDIN JSON payload into a DashboardEvent.
 * Returns null if the payload is invalid or irrelevant.
 * For stop events, reads the transcript file to capture AI output.
 */
export async function parseHookEvent(
  raw: string,
  tool: string,
  options?: ParseHookEventOptions,
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

  const isCopilot = tool.toLowerCase() === COPILOT_TOOL_ID;
  const derivedSessionId = deriveDispatchSessionId(hookData, tool);
  // Copilot IDs are persisted, so reject path-like IDs even when supplied directly.
  const sessionId = isCopilot && !COPILOT_SESSION_ID_RE.test(derivedSessionId)
    ? `pid-${process.ppid ?? process.pid}`
    : derivedSessionId;
  const cwd = isCopilot ? undefined : resolveHookCwd(hookData);

  const providerTime = isCopilot && (typeof hookData.timestamp === 'string'
    || typeof hookData.timestamp === 'number')
    ? new Date(hookData.timestamp).getTime() : NaN;
  const event: DashboardEvent = {
    type: eventType,
    timestamp: Number.isFinite(providerTime)
      ? new Date(providerTime).toISOString() : new Date().toISOString(),
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
        // PID lookup failure must not discard the session lifecycle event.
        event.monitorPid = ppid;
      }
    }
  }

  // Extract prompt summary from UserPromptSubmit. Strip harness/hook injections
  // (task-notifications, system-reminders, interrupt markers) that also fire this
  // hook — a background task completing is not a human prompt turn. A prompt that
  // is purely injected content produces no event at all, so it neither inflates the
  // prompt count nor shows up as a session prompt.
  if (eventType === 'prompt_submit' && typeof hookData.prompt === 'string') {
    const human = stripInjectedPrompt(hookData.prompt);
    if (!human) return null;
    // Decide "correction" here, over the full prompt, because only the hook knows
    // which team (and so which extra keywords) the prompt belongs to. The
    // machine-level events file mixes sessions from every team. Do this before
    // dropping the original prompt so keywords beyond the persisted summary are
    // still detected.
    event.correction = isCorrectionPrompt(human, options?.correctionKeywords);
    // Persist only a redacted, capped summary. Redact before truncating so a
    // secret that crosses the 200-character boundary cannot be partially leaked.
    // Copilot prompts remain entirely absent from telemetry, matching its
    // provider-specific privacy contract while retaining the correction signal.
    if (!isCopilot) event.promptSummary = redactWithEnv(human).slice(0, 200);
  }

  // The transcript a session runs in records where it started, which a report
  // needs once compaction dropped the session's earlier events (#785). A
  // SessionStart on a resume from another project names a file that never
  // exists, so it is not kept there.
  if ((eventType === 'prompt_submit' || eventType === 'session_end') && !isCopilot
    && typeof hookData.transcript_path === 'string') {
    event.transcriptPath = hookData.transcript_path;
  }

  // Extract transcript path, AI output and intervention counts from Stop event
  if (eventType === 'stop' && !isCopilot && typeof hookData.transcript_path === 'string') {
    event.transcriptPath = hookData.transcript_path;
    const output = await readLastAssistantOutput(hookData.transcript_path);
    if (output) {
      event.stoppedOutput = output;
    }
    // Full-transcript snapshot of interrupt/tool_reject counts + token usage +
    // human prompt count (all idempotent, sourced from the non-compactable transcript).
    const scan = await scanTranscriptStop(hookData.transcript_path, { tool, modelAliases: options?.modelAliases });
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
    {
      const records = (scan.requestRecords ?? []).map((record) => ({
        ...record,
        timestamp: record.timestamp || event.timestamp,
      }));
      if (records.length) event.requestDaily = aggregateRequestDaily(records);
      await reconcileRequestLog(records);
    }
  }

  // SessionStart and SessionEnd run in separate processes. Capture the log
  // boundary and an already-written marker only when it has not closed or
  // appeared in a previous start event for this session.
  if (eventType === 'session_start' && isCopilot) {
    const transcriptPath = resolveCopilotUsageTranscript(sessionId);
    if (transcriptPath) {
      try {
        let boundary = (await fs.promises.stat(transcriptPath)).size;
        if (boundary > 0) {
          const tailSize = Math.min(boundary, COPILOT_USAGE_TAIL_BYTES);
          const tail = Buffer.alloc(tailSize);
          const fh = await fs.promises.open(transcriptPath, 'r');
          try {
            await fh.read(tail, 0, tailSize, boundary - tailSize);
          } finally {
            await fh.close();
          }
          if (tail[tailSize - 1] !== 10) {
            const newline = tail.lastIndexOf(10);
            if (newline >= 0) boundary = boundary - tailSize + newline + 1;
            else if (tailSize === boundary) boundary = 0;
          }
        }
        event.copilotRunStartOffset = boundary;
        const candidate = await findCopilotRunMarkerAfter(
          transcriptPath, Math.max(0, boundary - COPILOT_USAGE_TAIL_BYTES),
          NaN, NaN, false,
        );
        if (candidate) {
          const shutdown = await readLatestCopilotUsageFromTail(transcriptPath);
          const history = await readEventsRaw(getEventsPath());
          const previousStarts = history.filter((entry) => entry.tool === COPILOT_TOOL_ID
            && entry.sessionId === sessionId && entry.type === 'session_start');
          const reused = previousStarts.some((entry) => entry.copilotRunMarkerId === candidate.id);
          const unclaimedPrior = previousStarts.some(
            (entry) => typeof entry.copilotRunMarkerId !== 'string',
          );
          const closed = shutdown.shutdownObserved
            && typeof shutdown.shutdownOffset === 'number'
            && shutdown.shutdownOffset > candidate.offset;
          if (!reused && !unclaimedPrior && !closed) {
            event.copilotRunMarkerId = candidate.id;
            event.copilotRunMarkerOffset = candidate.offset;
          }
        }
      } catch {
        event.copilotRunStartOffset = 0;
      }
    }
  }

  // Copilot's session log contains prompts, tool arguments, assistant output,
  // and auth-bearing request metadata. Follow opaque event IDs, extract only
  // final shutdown counters, and never persist paths or transcript content.
  if (eventType === 'session_end' && isCopilot) {
    const transcriptPath = resolveCopilotUsageTranscript(sessionId);
    if (transcriptPath) {
      const history = await readEventsRaw(getEventsPath());
      const endTime = Date.parse(event.timestamp);
      const sessionHistory = history.filter((entry) => entry.tool === COPILOT_TOOL_ID
        && entry.sessionId === sessionId);
      // Copilot may omit the provider timestamp. A delayed End handler then has
      // only its receipt time, so two unmatched Starts make its run ambiguous.
      const starts = sessionHistory.filter((entry) => entry.type === 'session_start');
      let lastEnd = -1;
      for (let index = 0; index < sessionHistory.length; index++) {
        if (sessionHistory[index].type === 'session_end') lastEnd = index;
      }
      const pendingStarts = sessionHistory.slice(lastEnd + 1)
        .filter((entry) => entry.type === 'session_start');
      const start = Number.isFinite(providerTime)
        ? [...starts].reverse().find((entry) => Date.parse(entry.timestamp) <= endTime)
        : starts.length === 1 ? starts[0]
          : pendingStarts.length === 1 ? pendingStarts[0] : undefined;
      let usage: CopilotUsageObservation = { shutdownObserved: false };
      const startTime = start ? Date.parse(start.timestamp) : NaN;
      const boundary = start?.copilotRunStartOffset;
      const recovered = Number.isFinite(providerTime)
        && typeof boundary === 'number' && Number.isFinite(boundary)
        ? await findCopilotRunMarkerAfter(
          transcriptPath, boundary, startTime, endTime, Number.isFinite(providerTime),
        )
        : undefined;
      const stored = typeof start?.copilotRunMarkerId === 'string'
        && typeof start.copilotRunMarkerOffset === 'number'
        && Number.isFinite(start.copilotRunMarkerOffset)
        ? { id: start.copilotRunMarkerId, offset: start.copilotRunMarkerOffset }
        : undefined;
      // Without a provider End time, a later marker may belong to the next run
      // whose Start handler has not persisted yet. Only the marker claimed at
      // this Start can safely supply totals.
      const marker = Number.isFinite(providerTime) ? recovered ?? stored : stored;
      if (marker) {
        usage = await waitForCopilotRunUsage(transcriptPath, marker);
      } else if ((start && boundary === undefined && !stored)
        || (!start && sessionHistory.every((entry) => entry.type !== 'session_start'))) {
        // Pre-upgrade sessions lack a run marker: accept only a new shutdown
        // observed during this handler, never an unchanged historical record.
        const initial = await readLatestCopilotUsageFromTail(transcriptPath);
        usage = await waitForCopilotShutdownUsage(transcriptPath, initial);
      }
      if (usage.tokens) {
        event.tokens = usage.tokens;
        event.tokenScope = 'session';
      }
    }
  }

  return event;
}

// ─── JSONL persistence ──────────────────────────────────

/** Get events path (evaluated at call time). */
function getEventsPath(): string {
  return path.join(getUserHome(), '.teamai', 'dashboard', 'events.jsonl');
}

function getRequestsPath(): string {
  return path.join(getUserHome(), '.teamai', 'dashboard', 'requests.jsonl');
}

async function readLocalRequestRecords(): Promise<Map<string, LocalRequestRecord>> {
  const records = new Map<string, LocalRequestRecord>();
  try {
    const content = await fs.promises.readFile(getRequestsPath(), 'utf-8');
    for (const line of content.split('\n')) {
      try {
        const record = JSON.parse(line) as LocalRequestRecord;
        if (record.id && record.timestamp) records.set(record.id, record);
      } catch {
        // Skip partial or malformed lines.
      }
    }
  } catch {
    // No local request history yet.
  }
  return records;
}

function aggregateRequestDaily(records: LocalRequestRecord[]): Record<string, RequestCostMetrics> {
  const daily: Record<string, RequestCostMetrics> = {};
  for (const record of records) {
    const date = record.timestamp.slice(0, 10);
    const bucket = daily[date] ?? {
      pricedRequests: 0,
      costMicros: 0,
      cacheReadTokens: 0,
      cacheEligibleInputTokens: 0,
      priceVersion: record.priceVersion,
    };
    bucket.pricedRequests += 1;
    bucket.costMicros += record.costMicros;
    bucket.cacheReadTokens += record.cacheReadTokens;
    bucket.cacheEligibleInputTokens += record.inputTokens + record.cacheReadTokens + record.cacheCreationTokens;
    bucket.priceVersion = record.priceVersion;
    daily[date] = bucket;
  }
  return daily;
}

/** Upsert privacy-safe request details and retain only the latest 90 days locally. */
export async function reconcileRequestLog(
  incoming: LocalRequestRecord[],
  now = new Date(),
): Promise<void> {
  const requestsPath = getRequestsPath();
  const lockPath = `${requestsPath}.lock`;
  const cutoff = now.getTime() - 90 * 86_400_000;
  let lock: fs.promises.FileHandle | undefined;
  try {
    await ensureDir(path.dirname(requestsPath));
    for (let attempt = 0; attempt < 10 && !lock; attempt++) {
      try {
        lock = await fs.promises.open(lockPath, 'wx', 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!lock) throw new Error('request log is busy');
    let existing = '';
    try {
      existing = await fs.promises.readFile(requestsPath, 'utf-8');
    } catch {
      // First write.
    }
    const records = new Map<string, LocalRequestRecord>();
    for (const line of existing.split('\n')) {
      try {
        const record = JSON.parse(line) as LocalRequestRecord;
        if (record.id && Number.isFinite(Date.parse(record.timestamp)) && Date.parse(record.timestamp) >= cutoff) {
          records.set(record.id, record);
        }
      } catch {
        // Skip partial or malformed lines.
      }
    }
    for (const record of incoming) {
      if (record.id && Number.isFinite(Date.parse(record.timestamp)) && Date.parse(record.timestamp) >= cutoff) {
        records.set(record.id, record);
      }
    }
    const content = [...records.values()]
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .map((record) => JSON.stringify(record))
      .join('\n');
    const tempPath = `${requestsPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tempPath, content ? `${content}\n` : '', { encoding: 'utf-8', mode: 0o600 });
    await fs.promises.rename(tempPath, requestsPath);
  } catch (e) {
    log.warn(`dashboard: failed to update local request log: ${(e as Error).message}`);
  } finally {
    await lock?.close().catch(() => undefined);
    if (lock) await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}

/**
 * The key an event records for the scope that wrote it, and that a scope's
 * report matches (#785): a hash of the data home, so the log stores no path
 * (Copilot events persist none, #666). The data home is realpath'd, so a
 * symlinked checkout or macOS `/tmp` vs `/private/tmp` keys the same; a
 * Windows path also folds separators and case, as the report's cwd rule does.
 * A data home that is gone (an in-repo `.teamai` removed after migration)
 * keys through its parent's realpath.
 */
export async function dataHomeKey(dataHome: string): Promise<string> {
  const real = await fs.promises.realpath(dataHome).catch(() => !path.isAbsolute(dataHome) ? dataHome
    : fs.promises.realpath(path.dirname(dataHome)).then((p) => path.join(p, path.basename(dataHome)), () => dataHome));
  const norm = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(real) ? real.replace(/\\/g, '/').toLowerCase() : real;
  return createHash('sha256').update(norm.replace(/\/+$/, '')).digest('hex').slice(0, 16);
}

// ─── Events file lock (#804) ────────────────────────────
//
// appendEvent and compactEvents serialize on `<events file>.lock`, the
// pattern the usage file took for the same lost-update race (#788, #803):
// compaction's read-modify-write must not drop an append that lands while it
// runs, and two compactions must not interleave their rewrites. The holder
// first folds in the side files of appends that gave up waiting. A lock
// whose owner is gone is reclaimed (acquireLock).

/** A hook append waits at most ~250 ms for the events lock, inside its foreground budget. */
const EVENTS_APPEND_LOCK_WAIT = { attempts: 10, delayMs: 25 };
/** A compaction waits up to ~5 s for a peer's compaction to finish. */
const EVENTS_REWRITE_LOCK_WAIT = { attempts: 100, delayMs: 50 };

/**
 * Run `fn` holding the lock every writer of the events file takes (#804): a
 * hook append and the compaction rewrite. A rewrite then cannot drop an
 * append made while it runs, and two rewrites cannot interleave. Returns
 * false, without running `fn`, when the lock is still held after the wait.
 */
async function withEventsLock(
  eventsPath: string,
  wait: { attempts: number; delayMs: number },
  fn: () => Promise<void>,
): Promise<boolean> {
  const lockPath = `${eventsPath}.lock`;
  for (let i = 0; i < wait.attempts; i++) {
    if (await acquireLock(lockPath)) {
      try {
        await foldPendingEvents(eventsPath);
        await fn();
      } finally {
        await releaseLock(lockPath);
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, wait.delayMs));
  }
  return false;
}

/** Name prefix of the side files an append writes while the events lock is held. */
function eventsPendingPrefix(eventsPath: string): string {
  return `${path.basename(eventsPath, '.jsonl')}.pending-`;
}

/**
 * Append the side files of appends that gave up on the lock to the events
 * file, then remove them. Each holds one whole line; one without its newline
 * is still being written and waits for the next holder. A side file whose id
 * the file already holds was folded by a holder that died or could not remove
 * it, so it is not appended again; identical events keep their own ids and
 * lines.
 */
async function foldPendingEvents(eventsPath: string): Promise<void> {
  const dir = path.dirname(eventsPath);
  const prefix = eventsPendingPrefix(eventsPath);
  const names = await fs.promises.readdir(dir).catch(() => []);
  let folded: Set<string> | undefined;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue;
    const pendingPath = path.join(dir, name);
    try {
      const content = await fs.promises.readFile(pendingPath, 'utf-8');
      if (!content.endsWith('\n')) continue;
      const id = pendingIdOf(content);
      folded ??= new Set(
        (await fs.promises.readFile(eventsPath, 'utf-8').catch(() => '')).split('\n').map(pendingIdOf).filter((i) => i !== undefined),
      );
      if (id === undefined || !folded.has(id)) {
        await fs.promises.appendFile(eventsPath, content, 'utf-8');
        if (id !== undefined) folded.add(id);
      }
      await fs.promises.rm(pendingPath, { force: true });
    } catch (e) {
      log.debug(`dashboard: could not fold ${pendingPath} into ${eventsPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The id a side file gave its line, if the line has one. */
function pendingIdOf(line: string): string | undefined {
  if (!line.includes('"pendingId"')) return undefined;
  try {
    const { pendingId } = JSON.parse(line) as { pendingId?: unknown };
    return typeof pendingId === 'string' ? pendingId : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the temp copies a killed compaction left beside `target`; only the lock holder writes one. */
async function removeOrphanTemps(target: string): Promise<void> {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  const names = await fs.promises.readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^\d+\.[0-9a-f]{12}\.tmp$/.test(name.slice(prefix.length))) continue;
    await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
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
    const detail = event.toolName
      ? ` [tool=${event.toolName}]`
      : event.promptSummary
        ? ` [prompt=${event.promptSummary}]`
        : '';
    const summary = `dashboard: recorded ${event.type} for session ${event.sessionId.slice(0, 16)}${detail}`;
    if (await withEventsLock(eventsPath, EVENTS_APPEND_LOCK_WAIT, () => fs.promises.appendFile(eventsPath, line, 'utf-8'))) {
      log.debug(summary);
      return;
    }
    // The lock is still held: record the event in a side file of its own for
    // the next lock holder to fold in, rather than race a rewrite (#804).
    // It holds what the events file holds, so it gets no wider mode than that
    // file (the umask can only narrow it); owner-only while there is no file
    // yet. The id lets a fold tell whether this very line is already in the
    // file; readers drop it (readEventsRaw), so it never leaves this machine.
    const pendingId = randomUUID();
    const pendingPath = path.join(path.dirname(eventsPath), `${eventsPendingPrefix(eventsPath)}${pendingId}.jsonl`);
    const mode = await fs.promises.stat(eventsPath).then((s) => s.mode & 0o777, () => 0o600);
    await fs.promises.writeFile(pendingPath, JSON.stringify({ ...event, pendingId }) + '\n', { encoding: 'utf-8', flag: 'wx', mode });
    log.debug(`${summary} (in ${path.basename(pendingPath)}; ${path.basename(eventsPath)}.lock is held)`);
  } catch (e) {
    log.error(`dashboard: failed to write event: ${(e as Error).message}`);
  }
}

/**
 * Read raw events from the JSONL file, in file (append) order. Skips corrupted
 * lines. Callers that must preserve the on-disk stream verbatim (e.g. compaction)
 * use this; everything else goes through {@link readEvents}, which also dedupes.
 */
async function readEventsRaw(filePath: string): Promise<DashboardEvent[]> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const events: DashboardEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as DashboardEvent & { pendingId?: unknown };
        if (parsed.type && parsed.sessionId && parsed.timestamp) {
          // A folded side file's id stays in the file (foldPendingEvents) until
          // a compaction rewrites the line; no reader ever sees it.
          delete parsed.pendingId;
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

/**
 * Cross-tool duplicate window. When a host (e.g. Cursor) also loads claude's
 * `~/.claude/settings.json`, one action fires both that hook (`--tool claude`)
 * and the host's own hook (`--tool cursor`), writing two near-identical events
 * under the SAME sessionId. Observed skew is 7–172ms; 2s is a generous guard.
 * A shared sessionId across two DIFFERENT tools only happens under this bug —
 * genuine distinct-tool sessions get distinct session ids — so the window is a
 * secondary safety check, not the primary discriminator.
 */
const CROSS_TOOL_DEDUP_WINDOW_MS = 2000;

/** Content signature within a session: distinguishes genuine repeats from dupes. */
function eventSignature(e: DashboardEvent): string {
  switch (e.type) {
    case 'tool_use': return `tool_use\0${e.toolName ?? ''}`;
    case 'prompt_submit': return `prompt_submit\0${e.promptSummary ?? ''}`;
    default: return e.type; // session_start | session_end | stop | process_exit
  }
}

/** Higher = richer payload; the richer record is kept as the surviving carrier. */
function eventPayloadScore(e: DashboardEvent): number {
  return (e.tokens ? 8 : 0) + (e.stoppedOutput ? 4 : 0) + (e.interventions ? 2 : 0)
    + (typeof e.prompts === 'number' ? 2 : 0) + (e.requestMetrics || e.requestDaily ? 2 : 0)
    + (e.monitorPid ? 1 : 0);
}

/** A specific host wins over the generic `claude` default (index.ts hook --tool). */
function preferTool(a: string, b: string): string {
  if (a === b) return a;
  if (a === 'claude') return b;
  if (b === 'claude') return a;
  return a; // both specific (shouldn't occur under the bug): keep earliest deterministically
}

/**
 * Collapse cross-tool duplicate events (see {@link CROSS_TOOL_DEDUP_WINDOW_MS}).
 * Two events merge only when they share sessionId + type + content signature, are
 * within the window, and have DIFFERENT tools — so genuine same-tool repeats and
 * single-tool sessions pass through untouched. The surviving record keeps the
 * richest payload and adopts the specific host tool. Output is timestamp-ascending.
 */
export function dedupeEvents(events: DashboardEvent[]): DashboardEvent[] {
  const sorted = [...events].sort((x, y) => Date.parse(x.timestamp) - Date.parse(y.timestamp));
  const result: DashboardEvent[] = [];
  const lastByKey = new Map<string, number>(); // (sessionId\0signature) -> index in result
  for (const e of sorted) {
    const key = `${e.sessionId}\0${eventSignature(e)}`;
    const idx = lastByKey.get(key);
    if (idx !== undefined) {
      const prev = result[idx];
      const gap = Math.abs(Date.parse(e.timestamp) - Date.parse(prev.timestamp));
      if (prev.tool !== e.tool && gap <= CROSS_TOOL_DEDUP_WINDOW_MS) {
        const carrier = eventPayloadScore(e) > eventPayloadScore(prev) ? e : prev; // tie -> prev (earlier)
        result[idx] = { ...carrier, tool: preferTool(prev.tool, e.tool) };
        continue; // collapsed; do not push
      }
    }
    result.push(e);
    lastByKey.set(key, result.length - 1);
  }
  return result;
}

/**
 * Read all events from the JSONL file, cross-tool-deduped. Skips corrupted lines.
 */
export async function readEvents(eventsPath?: string): Promise<DashboardEvent[]> {
  const filePath = eventsPath ?? getEventsPath();
  return dedupeEvents(await readEventsRaw(filePath));
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
 * - session_end / process_exit → mark as stopped (process truly exited)
 * Then apply timeouts: idle after 5 min, remove stale after 30 min.
 * Stopped sessions are kept for 30 seconds before removal.
 */
export function rebuildSessions(events: DashboardEvent[]): DashboardSession[] {
  const sessions = new Map<string, DashboardSession>();
  const now = Date.now();
  const keys = repoKeys(events);
  const allKeys = new Set(keys.values());

  for (const event of events) {
    let session = sessions.get(event.sessionId);

    if (!session) {
      const repoKey = keys.get(event.sessionId) ?? '';
      session = {
        sessionId: event.sessionId,
        tool: event.tool,
        status: 'running',
        cwd: event.cwd ?? '',
        repoKey,
        repoLabel: repoLabel(repoKey, allKeys),
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
      case 'session_end':
        session.status = 'stopped';
        session.stoppedAt = event.timestamp;
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
  // Per rollout, for a transcript-scoped session (Codex), whose counters restart
  // with each rollout: see SessionMetrics.segments.
  const rolloutSessions = new Set<string>();
  const transcriptPrompts = new Map<string, Map<string, number>>();
  const transcriptInterventions = new Map<string, Map<string, { interrupt: number; toolReject: number }>>();
  const transcriptRequests = new Map<string, Map<string, Record<string, RequestCostMetrics>>>();
  const transcriptCorrections = new Map<string, Map<string, number>>();
  const transcriptErrors = new Map<string, Set<string>>();
  const transcriptSubmits = new Map<string, Map<string, number>>();
  const stopAt = new Map<string, Map<string, number>>();
  const transcriptSince = new Map<string, Map<string, string>>();
  const lastTranscript = new Map<string, string>();
  const timeline = new Map<string, Array<{ at: number; transcript: string | undefined }>>();

  for (const event of events) {
    let m = map.get(event.sessionId);
    if (!m) {
      m = { interrupt: 0, toolReject: 0, correction: 0, prompts: 0, tokens: emptyTokenUsage() };
      map.set(event.sessionId, m);
    }
    if (typeof event.transcriptPath === 'string') {
      const since = transcriptSince.get(event.sessionId) ?? new Map<string, string>();
      const first = since.get(event.transcriptPath);
      if (first === undefined || Date.parse(event.timestamp) < Date.parse(first)) since.set(event.transcriptPath, event.timestamp);
      transcriptSince.set(event.sessionId, since);
      lastTranscript.set(event.sessionId, event.transcriptPath);
    }
    if (event.tokenScope === 'transcript' || (isCodexTool(event.tool) && typeof event.transcriptPath === 'string')) {
      rolloutSessions.add(event.sessionId);
    }
    const events = timeline.get(event.sessionId) ?? [];
    const rolloutOf = event.transcriptPath ?? lastTranscript.get(event.sessionId);
    events.push({ at: Date.parse(event.timestamp), transcript: rolloutOf });
    timeline.set(event.sessionId, events);
    if (event.status === 'error' && rolloutOf !== undefined) {
      transcriptErrors.set(event.sessionId, (transcriptErrors.get(event.sessionId) ?? new Set<string>()).add(rolloutOf));
    }
    if (event.type === 'prompt_submit' && rolloutOf !== undefined) {
      const submits = transcriptSubmits.get(event.sessionId) ?? new Map<string, number>();
      submits.set(rolloutOf, (submits.get(rolloutOf) ?? 0) + 1);
      transcriptSubmits.set(event.sessionId, submits);
    }
    if (event.type === 'stop' && typeof event.transcriptPath === 'string') {
      const rollout = event.transcriptPath;
      // The latest Stop by its timestamp, as for tokens: background Stop
      // handlers may append an older scan after a newer one.
      const at = Date.parse(event.timestamp);
      const latest = stopAt.get(event.sessionId) ?? new Map<string, number>();
      const seen = latest.get(rollout);
      const newest = seen === undefined || !Number.isFinite(at) || !Number.isFinite(seen) || at >= seen;
      if (newest) {
        latest.set(rollout, at);
        stopAt.set(event.sessionId, latest);
      }
      const record = <T>(maps: Map<string, Map<string, T>>, value: T) => {
        if (!newest) return;
        const perRollout = maps.get(event.sessionId) ?? new Map<string, T>();
        perRollout.set(rollout, value);
        maps.set(event.sessionId, perRollout);
      };
      if (typeof event.prompts === 'number') record(transcriptPrompts, event.prompts);
      if (event.interventions) {
        record(transcriptInterventions, { interrupt: event.interventions.interrupt, toolReject: event.interventions.toolReject });
      }
      // An older Stop records its cost as one request, on its own day.
      if (event.requestDaily) record(transcriptRequests, event.requestDaily);
      else if (event.requestMetrics) record(transcriptRequests, { [event.timestamp.slice(0, 10)]: event.requestMetrics });
    }

    if (event.type === 'stop') {
      if (event.interventions) {
        m.interrupt = event.interventions.interrupt;
        m.toolReject = event.interventions.toolReject;
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
        // Legacy events (no `correction` flag) fall back to the built-in list.
        const isCorrection = event.correction ?? isCorrectionPrompt(event.promptSummary);
        if (gap >= 0 && gap <= CORRECTION_WINDOW_MS && isCorrection) {
          m.correction++;
          const rollout = event.transcriptPath ?? lastTranscript.get(event.sessionId);
          if (rollout !== undefined) {
            const corrections = transcriptCorrections.get(event.sessionId) ?? new Map<string, number>();
            corrections.set(rollout, (corrections.get(rollout) ?? 0) + 1);
            transcriptCorrections.set(event.sessionId, corrections);
          }
        }
        // Each stop is consumed once — a later prompt is a new task, not a correction.
        lastStopAt.delete(event.sessionId);
      }
    }

    if ((event.type === 'stop' || event.type === 'session_end') && event.tokens) {
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
      m.tokensSpanRollouts = true;
    } else if (segments && segments.size > 0) {
      let total = emptyTokenUsage();
      for (const segment of segments.values()) total = addTokenUsage(total, segment.tokens);
      m.tokens = total;
    } else {
      const unscoped = unscopedTokens.get(sid);
      if (unscoped) m.tokens = { ...unscoped.tokens };
    }
    if (rolloutSessions.has(sid)) {
      // Active time per rollout: each gap goes to the rollout of the event it ends at.
      const durations = new Map<string, number>();
      const own = [...(timeline.get(sid) ?? [])].sort((a, b) => a.at - b.at);
      for (let i = 1; i < own.length; i++) {
        const gap = own[i].at - own[i - 1].at;
        const rollout = own[i].transcript;
        if (rollout !== undefined && Number.isFinite(gap) && gap >= 0 && gap <= DASHBOARD_IDLE_TIMEOUT_MS) {
          durations.set(rollout, (durations.get(rollout) ?? 0) + gap);
        }
      }
      const since = transcriptSince.get(sid) ?? new Map<string, string>();
      m.segments = Object.fromEntries([...since].map(([transcript, first]) => [transcript, {
        // A Codex Stop may count no prompts: the rollout's submits then do.
        prompts: Math.max(transcriptPrompts.get(sid)?.get(transcript) ?? 0, transcriptSubmits.get(sid)?.get(transcript) ?? 0),
        // A session-scoped counter already spans the rollouts: none holds tokens of its own.
        tokens: { ...(sessionSnapshot ? emptyTokenUsage() : segments?.get(transcript)?.tokens ?? emptyTokenUsage()) },
        interrupt: transcriptInterventions.get(sid)?.get(transcript)?.interrupt ?? 0,
        toolReject: transcriptInterventions.get(sid)?.get(transcript)?.toolReject ?? 0,
        correction: transcriptCorrections.get(sid)?.get(transcript) ?? 0,
        durationMs: durations.get(transcript) ?? 0,
        requestDaily: transcriptRequests.get(sid)?.get(transcript) ?? {},
        since: first,
        error: transcriptErrors.get(sid)?.has(transcript) ?? false,
      }]));
      // A rollout's Stop counts restart too; the session sums them.
      const sum = (field: 'interrupt' | 'toolReject') =>
        Object.values(m.segments ?? {}).reduce((total, segment) => total + segment[field], 0);
      m.interrupt = Math.max(m.interrupt, sum('interrupt'));
      m.toolReject = Math.max(m.toolReject, sum('toolReject'));
    }
    // A rollout's prompt count restarts too: its segments sum where they exist.
    const rolloutPrompts = m.segments
      ? Object.values(m.segments).reduce((sum, segment) => sum + segment.prompts, 0) : 0;
    m.prompts = Math.max(submitCount.get(sid) ?? 0, stopPrompts.get(sid) ?? 0, rolloutPrompts);
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
 * Active = not stopped and last activity within STALE_TIMEOUT, or its tool
 * process still running: an exit a dashboard wrote before `processExitAfter`
 * existed can mark a live run stopped, and dropping that run's start would give
 * its next activity a new run ID (#785).
 * Called when file exceeds COMPACTION_THRESHOLD lines.
 */
export async function compactEvents(eventsPath?: string): Promise<void> {
  const filePath = eventsPath ?? getEventsPath();
  try {
    const locked = await withEventsLock(filePath, EVENTS_REWRITE_LOCK_WAIT, async () => {
      // Replace the file itself, not a symlink to it.
      const target = await fs.promises.realpath(filePath).catch(() => filePath);
      await removeOrphanTemps(target);
      const content = await fs.promises.readFile(target, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      if (lines.length < DASHBOARD_COMPACTION_THRESHOLD) return;

      // Compaction rewrites the file, so it must preserve raw (append-order,
      // un-deduped) events — dedup is a read-time view, not a disk mutation.
      // Dedup never changes the active-session set, so activeIds is identical.
      const events = await readEventsRaw(target);
      const activeSessions = rebuildSessions(events);
      const activeIds = new Set(activeSessions.map(s => s.sessionId));
      const monitored = new Map<string, number>();
      for (const e of events) {
        if (e.type === 'session_start' && typeof e.monitorPid === 'number') monitored.set(e.sessionId, e.monitorPid);
      }
      for (const [sessionId, pid] of monitored) {
        if (isProcessAlive(pid)) activeIds.add(sessionId);
      }

      // Keep only events for active sessions
      const kept = events.filter(e => activeIds.has(e.sessionId));
      const compacted = kept.map(e => JSON.stringify(e)).join('\n') + '\n';

      // Atomic write: write to temp with the file's mode, then rename. The
      // lock makes the temp name ours; a killed compaction's copy is an
      // orphan a later one removes (removeOrphanTemps).
      const mode = await fs.promises.stat(target).then((s) => s.mode & 0o7777, () => 0o600);
      const tmpPath = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.promises.writeFile(tmpPath, compacted, { encoding: 'utf-8', mode });
        await fs.promises.rename(tmpPath, target);
      } catch (e) {
        await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
        throw e;
      }

      log.debug(`dashboard: compacted ${lines.length} → ${kept.length} events`);
    });
    // An opportunistic cleanup: leave the file as it is and let the next
    // compaction try again, rather than reporting a lost race as a failure.
    if (!locked) log.debug(`dashboard: ${path.basename(filePath)}.lock is still held after 5 s, so compaction is skipped`);
  } catch (e) {
    log.error(`dashboard: compaction failed: ${(e as Error).message}`);
  }
}

/** What a session last recorded: its scope and the repo it was in. */
interface RecordedScope {
  /** The last event's data home key, with the `projectAnchor` of that same event. */
  scope?: { key: string; anchor: string | undefined };
  /** The last `projectAnchor` the session recorded (#809's attribution rule). */
  projectAnchor?: string;
}

const recordedScopes = new Map<string, Promise<RecordedScope>>();

/**
 * What the session last recorded at `cwd`, else anywhere. A detached hook (a
 * Stop's) can run after the session moved on, so its own directory comes first.
 * Read once per process, and only for a hook whose cwd is gone: every other
 * hook resolves its scope from its cwd without touching events.jsonl.
 */
function recordedScope(sessionId: string, cwd: string): Promise<RecordedScope> {
  const key = `${sessionId}\0${cwd}`;
  let known = recordedScopes.get(key);
  if (!known) {
    known = readEvents().then((events) => {
      const own = events.filter((e) => e.sessionId === sessionId).reverse();
      const here = own.filter((e) => e.cwd === cwd);
      const scoped = here.find((e) => e.dataHomeKey) ?? own.find((e) => e.dataHomeKey);
      return {
        scope: scoped?.dataHomeKey ? { key: scoped.dataHomeKey, anchor: scoped.projectAnchor } : undefined,
        projectAnchor: (here.find((e) => e.projectAnchor) ?? own.find((e) => e.projectAnchor))?.projectAnchor,
      };
    });
    recordedScopes.set(key, known);
  }
  return known;
}

/**
 * The directory a hook's scope is resolved from (#810): its cwd. A cwd that no
 * longer exists (a removed worktree) would resolve to the user scope, so it is
 * instead the checkout of the repo this session last recorded (at that cwd
 * first, else anywhere: see recordedScope), when the config
 * there is still the scope that event's data home key names, or cannot be read (so
 * the hook gets no scope, never the user scope, #748). With nothing recorded to
 * match, it is the cwd, today's answer. A cwd that exists costs nothing more.
 */
export async function hookScopeDir(hookData: Record<string, unknown>, tool: string): Promise<string | undefined> {
  const cwd = resolveHookCwd(hookData);
  if (!cwd || fs.existsSync(cwd)) return cwd;
  const { scope } = await recordedScope(deriveDispatchSessionId(hookData, tool), cwd);
  const checkout = scope?.anchor ? await checkoutOf(scope.anchor) : undefined;
  if (scope && checkout) {
    const { resolveConfigForDir } = await import('./config.js');
    const config = await resolveConfigForDir(checkout);
    if (!config || await dataHomeKey(getDataHome(config)) === scope.key) return checkout;
  }
  return cwd;
}

/**
 * The scope a hook reports to: resolveConfigForDir at {@link hookScopeDir}. The
 * dispatcher and the legacy `dashboard-report`, `track` and `track-slash` entry
 * points all resolve through here.
 */
export async function resolveHookConfig(hookData: Record<string, unknown>, tool: string): Promise<LocalConfig | null> {
  const { resolveConfigForDir } = await import('./config.js');
  return resolveConfigForDir(await hookScopeDir(hookData, tool));
}

/**
 * A checkout of the repo anchored at `anchor` to resolve its scope from: the
 * anchor itself, or for a bare repo (whose anchor is the git directory, which
 * detection cannot read) the first of its worktrees that still exists.
 */
async function checkoutOf(anchor: string): Promise<string | undefined> {
  if (!fs.existsSync(anchor)) return undefined;
  if (fs.existsSync(path.join(anchor, '.git'))) return anchor;
  const { listWorktrees } = await import('./utils/git.js');
  return (await listWorktrees(anchor)).find((dir) => dir !== anchor && fs.existsSync(dir));
}

/**
 * The `projectAnchor` an event records (#809): the main checkout of the repo
 * holding the event's `cwd`, the directory the hook resolved its scope for.
 * Undefined for an event that records no cwd, which keeps it free of paths
 * (Copilot), and outside git. For a cwd that no longer exists, which git refuses
 * to open, it is the last anchor the session recorded there, else anywhere
 * (#810). Both event writers go through here.
 */
export async function eventProjectAnchor(cwd: string | undefined, sessionId: string): Promise<string | undefined> {
  if (!cwd) return undefined;
  if (!fs.existsSync(cwd)) return (await recordedScope(sessionId, cwd)).projectAnchor;
  const { resolveAnchors } = await import('./utils/git.js');
  return (await resolveAnchors(cwd))?.projectAnchor;
}

// ─── CLI entry point ────────────────────────────────────

/**
 * Handle `teamai dashboard-report --stdin --tool <name>`.
 * Called by dashboard hooks in Claude Code / other AI tools.
 *
 * Legacy entry point: a current install only writes `teamai hook-dispatch`,
 * whose dashboard-report handler is registered with `requiresConfig`. Hooks
 * left behind by an earlier install still call this command in every
 * directory, so it applies the same gate itself — a directory with no teamai
 * config has no team to report its sessions to (#768).
 */
export async function dashboardReport(toolArg?: string): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    log.debug('dashboard-report: no STDIN data');
    return;
  }

  // Asked about the session's cwd, never the directory this process started in.
  let hookData: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      hookData = parsed as Record<string, unknown>;
    }
  } catch {
    // parseHookEvent reports the malformed payload below; nothing to gate on yet.
  }
  const config = await resolveHookConfig(hookData, toolArg ?? 'claude');
  if (!config) {
    log.debug('dashboard-report: teamai is not set up here, skipping');
    return;
  }

  const event = await parseHookEvent(raw, toolArg ?? 'claude');
  if (!event) return;

  event.dataHomeKey = await dataHomeKey(getDataHome(config));
  event.projectAnchor = await eventProjectAnchor(event.cwd, event.sessionId);
  await appendEvent(event);

  // Trigger compaction check (non-blocking)
  compactEvents().catch(() => {});
}
