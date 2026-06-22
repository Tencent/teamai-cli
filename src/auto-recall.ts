import path from 'node:path';
import fs from 'node:fs';
import { log } from './utils/logger.js';
import { getTeamaiHome } from './types.js';

// ─── Auto-recall data flow ──────────────────────────────
//
//  PostToolUse hook (matcher: '*', every tool call)
//      │
//      ▼
//  teamai auto-recall --stdin
//      │
//      ├─ Read STDIN JSON { tool_name, tool_input, tool_response }
//      │
//      ├─ tool_name dispatch (fast path: unknown tools → exit <1ms)
//      │   ├─ 'Bash'      → containsError(output)? → extractQuery(output)
//      │   ├─ 'Grep'      → extractGrepQuery(tool_input)
//      │   ├─ 'WebSearch'  → extractWebSearchQuery(tool_input)
//      │   ├─ 'WebFetch'   → extractWebFetchQuery(tool_input)
//      │   └─ *            → exit(0), no-op
//      │
//      ├─ shouldSkipQuery(sessionId, query)  ← dedup + rate limit
//      │
//      ├─ search(query, index) ← lazy import
//      │
//      └─ Has results? → STDOUT JSON { additionalContext }
//         No results? → exit(0), no STDOUT
//

// ─── Tool whitelist ────────────────────────────────────

/** Tools that trigger auto-recall. */
const RECALL_TOOLS = new Set(['Bash', 'Grep', 'WebSearch', 'WebFetch']);

// ─── Error detection patterns (Bash only) ──────────────

/** Read-only commands whose output is file content, not execution results. */
const READ_ONLY_COMMANDS = ['cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat'];

/**
 * Check if a Bash command is a read-only file viewer.
 * Output from these commands is file content, not error output,
 * so it should never trigger error detection.
 *
 * Piped commands (e.g. `cat x | grep Error`) are NOT considered
 * read-only because the downstream command may produce real errors.
 */
export function isReadOnlyCommand(command: string): boolean {
    if (!command) return false;

    // If the command contains a pipe, it's not purely read-only
    if (command.includes('|')) return false;

    // Extract the base command (first word)
    const baseCmd = command.trim().split(/\s+/)[0];
    return READ_ONLY_COMMANDS.includes(baseCmd);
}

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
    /\bError\s+Handling\b/i,              // Topic heading "Error Handling"
    /\bError\s+Recovery\b/i,              // Topic heading "Error Recovery"
    /\bError\s+Types?\b/i,               // Topic heading "Error Types"
    /catch\s*\(/,                          // catch blocks in code
    /try\s*\{/,                            // try blocks in code
    /\.\w+\s*\(/,                          // Method calls: foo.bar(, pullSpin.warn(
    /=>\s*\{/,                             // Arrow functions: => {
    /`[^`]*\$\{/,                          // Template literals: `...${
    /\bfunction\s+\w+/,                    // Function declarations
    /\bconst\s+\w+\s*=/,                   // const declarations
    /\blet\s+\w+\s*=/,                     // let declarations
    /\bimport\s+/,                         // import statements
    /\bexport\s+/,                         // export statements
];

/** Maximum length of tool_output to scan for errors. */
const MAX_SCAN_LENGTH = 5000;

/** Maximum number of auto-recalls per session. */
const MAX_RECALLS_PER_SESSION = 10;

/** Session recall cache file TTL (24 hours). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Error detection (Bash path) ─────────────────────────

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

// ─── Search tool query extractors ────────────────────────

/**
 * Extract a search query from Grep tool_input.
 *
 * Grep input format: { pattern: string, path?: string, glob?: string, ... }
 * Strips regex metacharacters to get meaningful search words.
 */
export function extractGrepQuery(toolInput: Record<string, unknown>): string {
    const pattern = typeof toolInput.pattern === 'string' ? toolInput.pattern : '';
    if (!pattern) return '';

    // Strip common regex metacharacters, keep word content
    const query = pattern
        .replace(/[\\^$.*+?()[\]{}|]/g, ' ')
        .replace(/\\[bBdDwWsS]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (query.length < 3) return '';
    if (query.length > 120) return query.slice(0, 120).trim();

    return query;
}

/**
 * Extract a search query from WebSearch tool_input.
 *
 * WebSearch input format: { query: string, ... }
 * The query is already natural language — use as-is.
 */
export function extractWebSearchQuery(toolInput: Record<string, unknown>): string {
    const query = typeof toolInput.query === 'string' ? toolInput.query : '';
    if (!query || query.trim().length < 3) return '';

    const trimmed = query.trim();
    if (trimmed.length > 120) return trimmed.slice(0, 120).trim();

    return trimmed;
}

/**
 * Extract a search query from WebFetch tool_input.
 *
 * WebFetch input format: { url: string, prompt: string }
 * Prefer prompt (descriptive), fallback to URL path segments.
 */
export function extractWebFetchQuery(toolInput: Record<string, unknown>): string {
    // Prefer prompt — it describes what the user wants to find
    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    if (prompt && prompt.trim().length >= 3) {
        const trimmed = prompt.trim();
        if (trimmed.length > 120) return trimmed.slice(0, 120).trim();
        return trimmed;
    }

    // Fallback: extract meaningful words from URL path
    const url = typeof toolInput.url === 'string' ? toolInput.url : '';
    if (!url) return '';

    try {
        const parsed = new URL(url);
        const pathWords = parsed.pathname
            .split(/[/\-_.]+/)
            .filter((w) => w.length > 2)
            .filter((w) => !/^(www|com|org|net|io|html|htm|php|asp|jsx?)$/i.test(w))
            .join(' ');

        if (pathWords.length < 3) return '';
        if (pathWords.length > 120) return pathWords.slice(0, 120).trim();
        return pathWords;
    } catch {
        return '';
    }
}

// ─── Deduplication cache ─────────────────────────────────

interface RecallCache {
    queries: string[];
    count: number;
    updatedAt: string;
    /** Phase 2: 本 session 所有 recall 中的最高匹配分 */
    topScore: number;
    /** Phase 2: 有结果返回的 recall 次数 */
    hitCount: number;
    /** Phase 2: 无结果返回的 recall 次数 */
    missCount: number;
}

function sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getCachePath(sessionId: string): string {
    const safeName = sanitizeSessionId(sessionId);
    return path.join(
        process.env.HOME ?? '',
        '.teamai',
        'sessions',
        `${safeName}-recall-cache.json`,
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
        const parsed = JSON.parse(raw) as Partial<RecallCache>;

        // Check TTL
        const age = Date.now() - new Date(parsed.updatedAt ?? '').getTime();
        if (age > CACHE_TTL_MS) return null;

        // Backward compat: old cache files lack quality fields; validate queries array
        const queries = Array.isArray(parsed.queries) && parsed.queries.every((q) => typeof q === 'string')
            ? parsed.queries
            : [];
        return {
            queries,
            count: typeof parsed.count === 'number' ? parsed.count : 0,
            updatedAt: parsed.updatedAt ?? new Date().toISOString(),
            topScore: typeof parsed.topScore === 'number' ? parsed.topScore : 0,
            hitCount: typeof parsed.hitCount === 'number' ? parsed.hitCount : 0,
            missCount: typeof parsed.missCount === 'number' ? parsed.missCount : 0,
        };
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
        topScore: 0,
        hitCount: 0,
        missCount: 0,
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
        topScore: cache.topScore,
        hitCount: cache.hitCount,
        missCount: cache.missCount,
    };
    writeCache(sessionId, updated);

    return false;
}

// ─── STDIN parsing ───────────────────────────────────────

interface HookInput {
    toolName: string;
    toolInput: Record<string, unknown>;
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

        // Parse tool_input (the parameters passed to the tool)
        const rawInput = data.tool_input;
        const toolInput: Record<string, unknown> =
            rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)
                ? rawInput as Record<string, unknown>
                : {};

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

        return { toolName, toolInput, toolOutput, sessionId };
    } catch {
        return null;
    }
}

// ─── Main entry point ────────────────────────────────────

/**
 * Handle `teamai auto-recall --stdin`.
 * Called by PostToolUse hook on every tool call.
 *
 * Dispatch by tool type:
 * - Bash: error detection → extract error keywords → search
 * - Grep/WebSearch/WebFetch: extract search query from tool_input → search
 * - Other tools: exit immediately (fast path <1ms)
 *
 * Performance contract:
 * - Unknown tool: < 1ms (no I/O)
 * - Known tool, no query: < 5ms
 * - Known tool + search: < 200ms typical
 *
 * Output: STDOUT JSON with hookSpecificOutput.additionalContext when matching results found.
 * Claude Code reads additionalContext and passes it to AI as context.
 */
export async function autoRecall(): Promise<void> {
    // ─── Eval harness: disable flag ────────────────────
    if (process.env.TEAMAI_RECALL_DISABLED === '1') {
        return;
    }

    const input = await readStdin();
    if (!input) {
        log.debug('auto-recall: no STDIN data');
        return;
    }

    const { toolName, toolInput, toolOutput, sessionId } = input;

    // Fast path: unknown tools → exit immediately
    if (!RECALL_TOOLS.has(toolName)) {
        return;
    }

    // ─── Extract query based on tool type ────────────────
    let query = '';

    if (toolName === 'Bash') {
        // Read-only commands output file content, not errors — skip
        const command = typeof toolInput.command === 'string' ? toolInput.command : '';
        if (isReadOnlyCommand(command)) {
            return;
        }
        // Skip our own output — prevents recursive false positives when
        // Bash output contains auto-recall / recall results markers
        if (toolOutput.includes('[teamai:')) {
            return;
        }
        // Bash: only recall on errors
        if (!containsError(toolOutput)) {
            return;
        }
        query = extractQuery(toolOutput);
    } else if (toolName === 'Grep') {
        query = extractGrepQuery(toolInput);
    } else if (toolName === 'WebSearch') {
        query = extractWebSearchQuery(toolInput);
    } else if (toolName === 'WebFetch') {
        query = extractWebFetchQuery(toolInput);
    }

    if (!query) {
        log.debug(`auto-recall: no query extracted from ${toolName}`);
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

    // Load search index (try project scope first, fallback to user scope)
    let indexPath: string | undefined;
    try {
        const { autoDetectInit } = await import('./config.js');
        const { localConfig } = await autoDetectInit();
        const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
        indexPath = path.join(teamaiHome, 'search-index.json');
    } catch { /* fallback to default user scope path */ }
    const index = await loadIndex(indexPath);
    if (!index || index.entries.length === 0) {
        log.debug('auto-recall: no search index available');
        // Phase 2: record miss even when index is empty/missing
        const cache = readCache(sessionId) ?? {
            queries: [], count: 0, updatedAt: new Date().toISOString(),
            topScore: 0, hitCount: 0, missCount: 0,
        };
        writeCache(sessionId, { ...cache, missCount: cache.missCount + 1, updatedAt: new Date().toISOString() });
        return;
    }

    // Search
    const searchStart = Date.now();
    const results = search(query, index, 3);

    // ─── Phase 2: update recall-cache quality fields ────
    {
        const cache = readCache(sessionId) ?? {
            queries: [],
            count: 0,
            updatedAt: new Date().toISOString(),
            topScore: 0,
            hitCount: 0,
            missCount: 0,
        };
        const bestScore = results.length > 0 ? results[0].score : 0;
        const updatedCache: RecallCache = {
            ...cache,
            topScore: Math.max(cache.topScore, bestScore),
            hitCount: results.length > 0 ? cache.hitCount + 1 : cache.hitCount,
            missCount: results.length > 0 ? cache.missCount : cache.missCount + 1,
            updatedAt: new Date().toISOString(),
        };
        writeCache(sessionId, updatedCache);
    }

    // ─── Eval harness: write structured log ────────────
    // Intentionally placed BEFORE the "no results" early return so that
    // zero-result searches are also logged — useful for eval gap analysis.
    const evalLogPath = process.env.TEAMAI_EVAL_LOG_PATH;
    if (evalLogPath) {
        const searchMs = Date.now() - searchStart;
        const evalEntry = JSON.stringify({
            query,
            results: results.map((r) => ({
                filename: r.entry.filename,
                title: r.entry.title,
                score: r.score,
                tags: r.entry.tags,
            })),
            searchMs,
            strategy: process.env.TEAMAI_SEARCH_STRATEGY ?? 'keyword-v1',
        });
        try {
            fs.appendFileSync(evalLogPath, evalEntry + '\n');
        } catch {
            // Silent: eval log failure should never affect hook output
        }
    }

    if (results.length === 0) {
        log.debug(`auto-recall: no results for query: ${query.slice(0, 50)}`);
        return;
    }

    // Log successful recall with titles for debuggability
    const titles = results.map((r) => r.entry.title).join(', ');
    log.debug(`auto-recall: [${toolName}] query="${query.slice(0, 60)}" → ${results.length} results: ${titles}`);

    // Format and output results via PostToolUse additionalContext JSON
    const source = toolName === 'Bash' ? '检测到错误' : `伴随 ${toolName} 搜索`;
    const header = `[teamai:auto-recall] ${source}，自动搜索团队知识库 (query: "${query.slice(0, 60)}")\n\n`;
    const formatted = formatResults(results);
    const context = (header + formatted).slice(0, 10000); // additionalContext limit

    const hookOutput = JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: context,
        },
    });
    process.stdout.write(hookOutput + '\n');

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

/**
 * Read recall quality metrics for a session (Phase 2).
 * Used by contribute-check to determine knowledge gap signal.
 * Returns null if no recall activity recorded for this session.
 */
export function readRecallQuality(sessionId: string): { topScore: number; hitCount: number; missCount: number } | null {
    const cache = readCache(sessionId);
    if (!cache) return null;
    // Only return quality data if at least one recall was actually executed
    if (cache.hitCount === 0 && cache.missCount === 0) return null;
    return {
        topScore: cache.topScore,
        hitCount: cache.hitCount,
        missCount: cache.missCount,
    };
}
