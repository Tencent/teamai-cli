import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { recordRecallQuality, readRecallQuality } from '../recall-quality.js';
import type { SearchResult } from '../utils/search-index.js';

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-quality-test-'));
}

function fakeResults(score: number): SearchResult[] {
    return [{ entry: {} as SearchResult['entry'], score }];
}

describe('recordRecallQuality', () => {
    let tmpDir: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        process.env.HOME = tmpDir;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('records a hit with the top score when results are non-empty', () => {
        recordRecallQuality('session-a', fakeResults(8.5));
        expect(readRecallQuality('session-a')).toEqual({ topScore: 8.5, hitCount: 1, missCount: 0 });
    });

    it('records a miss when results are empty', () => {
        recordRecallQuality('session-b', []);
        expect(readRecallQuality('session-b')).toEqual({ topScore: 0, hitCount: 0, missCount: 1 });
    });

    it('accumulates hit/miss counts and keeps the highest topScore across calls', () => {
        recordRecallQuality('session-c', fakeResults(3.0));
        recordRecallQuality('session-c', []);
        recordRecallQuality('session-c', fakeResults(9.0));

        expect(readRecallQuality('session-c')).toEqual({ topScore: 9.0, hitCount: 2, missCount: 1 });
    });
});

describe('readRecallQuality', () => {
    let tmpDir: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        process.env.HOME = tmpDir;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns null when no cache exists', () => {
        const result = readRecallQuality('nonexistent-session');
        expect(result).toBeNull();
    });

    it('returns null when cache has zero hit and miss counts', () => {
        const sessionId = 'zero-counts-session';
        const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionsDir, `${sessionId}-recall-cache.json`),
            JSON.stringify({
                queries: [],
                count: 0,
                updatedAt: new Date().toISOString(),
                topScore: 0,
                hitCount: 0,
                missCount: 0,
            }),
            'utf-8',
        );

        const result = readRecallQuality(sessionId);
        expect(result).toBeNull();
    });

    it('returns quality data when hitCount > 0', () => {
        const sessionId = 'hit-session';
        const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionsDir, `${sessionId}-recall-cache.json`),
            JSON.stringify({
                queries: ['test'],
                count: 1,
                updatedAt: new Date().toISOString(),
                topScore: 12.5,
                hitCount: 2,
                missCount: 1,
            }),
            'utf-8',
        );

        const result = readRecallQuality(sessionId);
        expect(result).toEqual({ topScore: 12.5, hitCount: 2, missCount: 1 });
    });

    it('handles legacy cache format (missing quality fields) gracefully', () => {
        const sessionId = 'legacy-session';
        const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionsDir, `${sessionId}-recall-cache.json`),
            JSON.stringify({
                queries: ['old'],
                count: 2,
                updatedAt: new Date().toISOString(),
            }),
            'utf-8',
        );

        const result = readRecallQuality(sessionId);
        expect(result).toBeNull();
    });

    it('returns null for expired cache (TTL exceeded)', () => {
        const sessionId = 'expired-session';
        const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        fs.writeFileSync(
            path.join(sessionsDir, `${sessionId}-recall-cache.json`),
            JSON.stringify({
                queries: ['q1'],
                count: 1,
                updatedAt: expiredAt,
                topScore: 8.0,
                hitCount: 1,
                missCount: 0,
            }),
            'utf-8',
        );

        const result = readRecallQuality(sessionId);
        expect(result).toBeNull();
    });
});
