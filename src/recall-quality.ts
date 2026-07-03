import path from 'node:path';
import fs from 'node:fs';
import type { SearchResult } from './utils/search-index.js';

// ─── Recall quality tracking ─────────────────────────────
//
//  `teamai recall` (manual CLI + the `teamai-recall` subagent, which shells
//  out to the same command) records a per-session quality signal every time
//  it runs a search: did it find anything, and how good was the top hit?
//
//  `contribute-check.ts` (Stop hook) reads this signal to detect sessions
//  where the team knowledge base likely has a gap — nudging the agent to
//  contribute a new learning. This used to be populated by the old
//  `auto-recall` PostToolUse hook (removed in favor of the explicit
//  `teamai-recall` subagent); the cache file format is unchanged so
//  `contribute-check` needs no changes beyond the import path.

interface RecallCache {
    queries: string[];
    count: number;
    updatedAt: string;
    /** Highest match score across all recalls in this session. */
    topScore: number;
    /** Number of recalls that returned at least one result. */
    hitCount: number;
    /** Number of recalls that returned zero results. */
    missCount: number;
}

/** Session recall cache file TTL (24 hours). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

function readCache(sessionId: string): RecallCache | null {
    try {
        const cachePath = getCachePath(sessionId);
        if (!fs.existsSync(cachePath)) return null;

        const raw = fs.readFileSync(cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<RecallCache>;

        const age = Date.now() - new Date(parsed.updatedAt ?? '').getTime();
        if (age > CACHE_TTL_MS) return null;

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

function writeCache(sessionId: string, cache: RecallCache): void {
    try {
        const cachePath = getCachePath(sessionId);
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
    } catch {
        // Best-effort, don't block the caller on cache write failure
    }
}

/**
 * Record the outcome of a `teamai recall` search for quality tracking.
 * Best-effort: never throws, never blocks the caller.
 */
export function recordRecallQuality(sessionId: string, results: SearchResult[]): void {
    try {
        const cache = readCache(sessionId) ?? {
            queries: [],
            count: 0,
            updatedAt: new Date().toISOString(),
            topScore: 0,
            hitCount: 0,
            missCount: 0,
        };
        const bestScore = results.length > 0 ? results[0].score : 0;
        const updated: RecallCache = {
            ...cache,
            count: cache.count + 1,
            topScore: Math.max(cache.topScore, bestScore),
            hitCount: results.length > 0 ? cache.hitCount + 1 : cache.hitCount,
            missCount: results.length > 0 ? cache.missCount : cache.missCount + 1,
            updatedAt: new Date().toISOString(),
        };
        writeCache(sessionId, updated);
    } catch {
        // Never let quality tracking affect the recall command itself
    }
}

/**
 * Read recall quality metrics for a session.
 * Used by contribute-check to determine knowledge gap signal.
 * Returns null if no recall activity recorded for this session.
 */
export function readRecallQuality(sessionId: string): { topScore: number; hitCount: number; missCount: number } | null {
    const cache = readCache(sessionId);
    if (!cache) return null;
    if (cache.hitCount === 0 && cache.missCount === 0) return null;
    return {
        topScore: cache.topScore,
        hitCount: cache.hitCount,
        missCount: cache.missCount,
    };
}
