import path from 'node:path';
import fs from 'node:fs';
import { log } from './utils/logger.js';

// ─── Auto-recall data flow ──────────────────────────────
//
//  PostToolUse hook (every tool call)
//      │
//      ▼
//  teamai auto-recall --stdin
//      │
//      ├─ Read STDIN JSON (tool_name, tool_output)
//      ├─ Quick check: tool_output contains error pattern?
//      │   ├─ NO → exit(0), no STDOUT (< 5ms)
//      │   └─ YES → extract error keywords as query
//      │           │
//      │           ▼
//      │       search(query, index) ← lazy import
//      │           │
//      │           ▼
//      │       Has results? → STDOUT formatted output
//      │       No results? → exit(0), no STDOUT
//      │
//      ▼
//  Claude reads hook STDOUT → sees team knowledge base matches
//

// ─── Error detection patterns ────────────────────────────

/** Patterns that indicate an error in tool output. */
const ERROR_PATTERNS: RegExp[] = [
    /\bError\b/,
    /\berror:/i,
    /\bFailed\b/i,
    /\bFATAL\b/,
    /\bTraceback\b/,
    /\bpanic:/,
    /\bENOENT\b/,
    /\bPermission denied\b/i,
    /\bcommand not found\b/i,
    /\bNo such file\b/i,
    /\bexit code [1-9]/i,
    /\btimeout\b/i,
    /\bOOM\b/,
    /\bKilled\b/,
    /\bSegmentation fault\b/i,
    /\bcore dumped\b/i,
    /\bModuleNotFoundError\b/,
    /\bImportError\b/,
    /\bSyntaxError\b/,
    /\bTypeError\b/,
    /\bNameError\b/,
    /\bKeyError\b/,
    /\bValueError\b/,
    /\bAttributeError\b/,
    /\bRuntimeError\b/,
    /\bConnectionRefusedError\b/,
    /\bFileNotFoundError\b/,
];

/** Patterns that indicate normal output (false positives to exclude). */
const FALSE_POSITIVE_PATTERNS: RegExp[] = [
    /^On branch /m,                       // git status
    /^modified:/m,                         // git status
    /^Switched to branch/m,               // git checkout
    /^\s*0 errors?\b/im,                  // "0 errors" is good
    /error_handling/i,                     // Variable/function names
    /error_message/i,                      // Variable/function names
    /error_code/i,                         // Variable/function names
    /on_error/i,                           // Variable/function names
    /error_log/i,                          // Variable/function names
    /error\.ts/i,                          // File names
    /error\.py/i,                          // File names
    /error\.js/i,                          // File names
    /errorHandler/i,                       // Function names
    /\"error\"\s*:/,                       // JSON key definition
    /catch\s*\(/,                          // catch blocks in code
    /try\s*\{/,                            // try blocks in code
];

/** Maximum length of tool_output to scan for errors. */
const MAX_SCAN_LENGTH = 5000;

/** Maximum number of auto-recalls per session. */
const MAX_RECALLS_PER_SESSION = 5;

/** Session recall cache file TTL (24 hours). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Error detection ─────────────────────────────────────

/**
 * Check if tool output contains error patterns.
 * Fast path: returns false quickly for normal output.
 */
export function containsError(output: string): boolean {
    if (!output || output.length === 0) return false;

    // Only scan the first N characters for performance
    const scanText = output.length > MAX_SCAN_LENGTH
        ? output.slice(0, MAX_SCAN_LENGTH)
        : output;

    // Check for false positives first (fast exit)
    const falsePositiveCount = FALSE_POSITIVE_PATTERNS.filter((p) => p.test(scanText)).length;
    const errorCount = ERROR_PATTERNS.filter((p) => p.test(scanText)).length;

    // If more false positives than errors, likely not a real error
    if (falsePositiveCount > 0 && errorCount <= falsePositiveCount) {
        return false;
    }

    return errorCount > 0;
}

/**
 * Extract a search query from error output.
 * Takes the most relevant error tokens, strips noise (paths, line numbers).
 */
export function extractQuery(output: string): string {
    // Only look at first portion
    const scanText = output.length > MAX_SCAN_LENGTH
        ? output.slice(0, MAX_SCAN_LENGTH)
        : output;

    // Try to find the most specific error line
    // Prefer the last matching error line (e.g. ModuleNotFoundError over Traceback)
    const lines = scanText.split('\n');
    let errorLine = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Prioritize lines with clear error patterns
        if (/\bError\b|error:|Failed|FATAL|panic:|ModuleNotFoundError|ImportError|command not found|Permission denied|ENOENT|No such file/i.test(trimmed)) {
            errorLine = trimmed;
            // Don't break — keep scanning for more specific errors
            // (e.g. "ModuleNotFoundError: ..." is better than "Traceback ...")
        }
    }

    if (!errorLine) {
        // Fallback: use first non-empty line that's not too short
        errorLine = lines.find((l) => l.trim().length > 10)?.trim() ?? '';
    }

    // Clean up the error line for search
    let query = errorLine
        // Remove ANSI escape codes
        .replace(/\x1b\[[0-9;]*m/g, '')
        // Remove file paths (Unix and Windows)
        .replace(/\/[\w./-]+/g, ' ')
        .replace(/[A-Z]:\\[\w.\\-]+/g, ' ')
        // Remove line numbers and column refs
        .replace(/\bline\s+\d+/gi, '')
        .replace(/:\d+:\d+/g, '')
        .replace(/\(\d+,\s*\d+\)/g, '')
        // Remove hex addresses
        .replace(/0x[0-9a-f]+/gi, '')
        // Remove timestamps
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '')
        // Remove long numeric sequences
        .replace(/\b\d{5,}\b/g, '')
        // Collapse whitespace
        .replace(/\s+/g, ' ')
        .trim();

    // Limit query length to avoid noise
    if (query.length > 120) {
        query = query.slice(0, 120).trim();
    }

    // Minimum viable query
    if (query.length < 3) {
        return '';
    }

    return query;
}

// ─── Deduplication cache ─────────────────────────────────

interface RecallCache {
    queries: string[];
    count: number;
    updatedAt: string;
}

function getCachePath(sessionId: string): string {
    return path.join(
        process.env.HOME ?? '',
        '.teamai',
        'sessions',
        `${sessionId}-recall-cache.json`,
    );
}

/**
 * Read the recall cache for a session.
 * Returns null if missing or corrupt.
 */
function readCache(sessionId: string): RecallCache | null {
    try {
        const cachePath = getCachePath(sessionId);
        if (!fs.existsSync(cachePath)) return null;

        const raw = fs.readFileSync(cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as RecallCache;

        // Check TTL
        const age = Date.now() - new Date(parsed.updatedAt).getTime();
        if (age > CACHE_TTL_MS) return null;

        return parsed;
    } catch {
        return null;
    }
}

/**
 * Write the recall cache for a session.
 */
function writeCache(sessionId: string, cache: RecallCache): void {
    try {
        const cachePath = getCachePath(sessionId);
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
    } catch {
        // Best-effort, don't block on cache write failure
    }
}

/**
 * Check if a query has been seen before in this session, and update cache.
 * Returns true if the query should be skipped (already seen or limit reached).
 */
export function shouldSkipQuery(sessionId: string, query: string): boolean {
    const cache = readCache(sessionId) ?? {
        queries: [],
        count: 0,
        updatedAt: new Date().toISOString(),
    };

    // Rate limit: max N recalls per session
    if (cache.count >= MAX_RECALLS_PER_SESSION) {
        return true;
    }

    // Dedup: normalize query for comparison
    const normalized = query.toLowerCase().trim();
    if (cache.queries.some((q) => q === normalized)) {
        return true;
    }

    // Update cache
    const updated: RecallCache = {
        queries: [...cache.queries, normalized],
        count: cache.count + 1,
        updatedAt: new Date().toISOString(),
    };
    writeCache(sessionId, updated);

    return false;
}

// ─── STDIN parsing ───────────────────────────────────────

interface HookInput {
    toolName: string;
    toolOutput: string;
    sessionId: string;
}

/**
 * Read and parse STDIN hook JSON.
 * Returns null if STDIN is a TTY or JSON is invalid.
 */
export async function readStdin(): Promise<HookInput | null> {
    if (process.stdin.isTTY) return null;

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw.trim()) return null;

    try {
        const data = JSON.parse(raw) as Record<string, unknown>;

        const toolName = typeof data.tool_name === 'string' ? data.tool_name : '';

        // Claude Code PostToolUse STDIN format:
        //   { tool_name, tool_input, tool_response: { stdout, stderr } }
        // Other formats may use tool_output or tool_result directly.
        const toolResponse = data.tool_response as Record<string, unknown> | undefined;
        const toolOutput = typeof data.tool_output === 'string'
            ? data.tool_output
            : typeof data.tool_result === 'string'
                ? data.tool_result
                : toolResponse
                    ? [
                        typeof toolResponse.stdout === 'string' ? toolResponse.stdout : '',
                        typeof toolResponse.stderr === 'string' ? toolResponse.stderr : '',
                    ].filter(Boolean).join('\n')
                    : '';

        // Derive session ID (same logic as contribute-check)
        const sessionId =
            (typeof data.session_id === 'string' && data.session_id) ||
            process.env.CLAUDE_SESSION_ID ||
            `pid-${process.ppid ?? process.pid}`;

        return { toolName, toolOutput, sessionId };
    } catch {
        return null;
    }
}

// ─── Main entry point ────────────────────────────────────

/**
 * Handle `teamai auto-recall --stdin`.
 * Called by PostToolUse hook on every tool call.
 *
 * Performance contract:
 * - No error detected: < 50ms (no index load, no search)
 * - Error detected + search: < 200ms typical
 *
 * Output: STDOUT when error detected and matching results found.
 * Claude Code reads hook STDOUT and passes it to AI as context.
 */
export async function autoRecall(): Promise<void> {
    const input = await readStdin();
    if (!input) {
        log.debug('auto-recall: no STDIN data');
        return;
    }

    const { toolOutput, sessionId } = input;

    // Fast path: no error detected → exit immediately
    if (!containsError(toolOutput)) {
        return;
    }

    // Extract search query from error
    const query = extractQuery(toolOutput);
    if (!query) {
        log.debug('auto-recall: could not extract query from error');
        return;
    }

    // Dedup: skip if same query already recalled in this session
    if (shouldSkipQuery(sessionId, query)) {
        log.debug(`auto-recall: skipping duplicate/rate-limited query: ${query.slice(0, 50)}`);
        return;
    }

    // Lazy load search modules (only when we actually need to search)
    const { loadIndex, search } = await import('./utils/search-index.js');
    const { formatResults } = await import('./recall.js');

    // Load search index
    const index = await loadIndex();
    if (!index || index.entries.length === 0) {
        log.debug('auto-recall: no search index available');
        return;
    }

    // Search
    const results = search(query, index, 3);
    if (results.length === 0) {
        log.debug(`auto-recall: no results for query: ${query.slice(0, 50)}`);
        return;
    }

    // Format and output results
    const header = `[teamai:auto-recall] 检测到错误，自动搜索团队知识库 (query: "${query.slice(0, 60)}")\n\n`;
    const formatted = formatResults(results);
    process.stdout.write(header + formatted + '\n');

    // Best-effort auto-upvote (non-blocking)
    try {
        const { autoUpvote } = await import('./recall.js');
        const { requireInit } = await import('./config.js');
        const { localConfig } = await requireInit();
        await autoUpvote(results, localConfig.username, localConfig.repo.localPath);
    } catch {
        // Silent: upvote failure should never affect hook output
    }
}
