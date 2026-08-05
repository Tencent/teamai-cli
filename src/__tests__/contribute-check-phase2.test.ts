import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyPhase2Adjustments, hasGitCommitInSession, contributeCheckForSession, writeContributeState } from '../contribute-check.js';
import { appendEvent } from '../dashboard-collector.js';
import {
    CONTRIBUTE_KNOWLEDGE_GAP_BONUS,
    CONTRIBUTE_LOW_QUALITY_BONUS,
    CONTRIBUTE_LOW_QUALITY_THRESHOLD,
    CONTRIBUTE_GIT_COMMIT_DOWNWEIGHT,
} from '../types.js';

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-p2-check-test-'));
}

function writeRecallCache(
    tmpDir: string,
    sessionId: string,
    data: object,
): void {
    const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionsDir, `${sessionId}-recall-cache.json`),
        JSON.stringify(data),
        'utf-8',
    );
}

describe('applyPhase2Adjustments', () => {
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

    it('returns base score unchanged when no recall-cache exists', () => {
        const result = applyPhase2Adjustments(40, 'no-cache-session');
        expect(result.score).toBe(40);
        expect(result.isKnowledgeGap).toBe(false);
        expect(result.hasGitCommit).toBe(false);
    });

    it('adds KNOWLEDGE_GAP_BONUS when all recalls missed', () => {
        const sessionId = 'all-miss-session';
        writeRecallCache(tmpDir, sessionId, {
            queries: ['q1'],
            count: 1,
            updatedAt: new Date().toISOString(),
            topScore: 0,
            hitCount: 0,
            missCount: 3,
        });

        const result = applyPhase2Adjustments(30, sessionId);
        expect(result.score).toBe(30 + CONTRIBUTE_KNOWLEDGE_GAP_BONUS);
        expect(result.isKnowledgeGap).toBe(true);
    });

    it('adds LOW_QUALITY_BONUS when top score below threshold', () => {
        const sessionId = 'low-quality-session';
        writeRecallCache(tmpDir, sessionId, {
            queries: ['q1'],
            count: 1,
            updatedAt: new Date().toISOString(),
            topScore: 3.0,
            hitCount: 2,
            missCount: 1,
        });

        const result = applyPhase2Adjustments(30, sessionId);
        expect(result.score).toBe(30 + CONTRIBUTE_LOW_QUALITY_BONUS);
        expect(result.isKnowledgeGap).toBe(true);
    });

    it('no bonus when recall quality is good (topScore >= threshold)', () => {
        const sessionId = 'good-quality-session';
        writeRecallCache(tmpDir, sessionId, {
            queries: ['q1'],
            count: 1,
            updatedAt: new Date().toISOString(),
            topScore: 10.0,
            hitCount: 3,
            missCount: 0,
        });

        const result = applyPhase2Adjustments(30, sessionId);
        expect(result.score).toBe(30);
        expect(result.isKnowledgeGap).toBe(false);
    });

    it('does not apply git commit downweight without cwd parameter', () => {
        const sessionId = 'no-cwd-session';
        writeRecallCache(tmpDir, sessionId, {
            queries: ['q1'],
            count: 1,
            updatedAt: new Date().toISOString(),
            topScore: 10.0,
            hitCount: 2,
            missCount: 0,
        });

        const result = applyPhase2Adjustments(50, sessionId);
        expect(result.score).toBe(50);
        expect(result.hasGitCommit).toBe(false);
    });

    it('score cannot go below 0 after adjustments', () => {
        const sessionId = 'floor-session';
        writeRecallCache(tmpDir, sessionId, {
            queries: ['q1'],
            count: 1,
            updatedAt: new Date().toISOString(),
            topScore: 10.0,
            hitCount: 2,
            missCount: 0,
        });

        const gitRepo = path.resolve(__dirname, '../../');
        const veryOldStart = '2020-01-01T00:00:00Z';
        const result = applyPhase2Adjustments(5, sessionId, gitRepo, veryOldStart);
        expect(result.score).toBe(5);
    });
});

describe('hasGitCommitInSession', () => {
    it('returns false for non-git directory', () => {
        const result = hasGitCommitInSession('/tmp', '2020-01-01T00:00:00Z');
        expect(result).toBe(false);
    });

    it('returns false for nonexistent directory', () => {
        const result = hasGitCommitInSession('/tmp/nonexistent-dir-xyz', '2020-01-01T00:00:00Z');
        expect(result).toBe(false);
    });
});

describe('buildHint text differentiation', () => {
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

    async function seedHighScoreSession(sessionId: string): Promise<void> {
        const count = 50;
        const now = Date.now();
        const tools = ['Bash', 'Read', 'Edit', 'Skill', 'Grep'];
        for (let i = 0; i < count; i++) {
            await appendEvent({
                type: 'tool_use',
                sessionId,
                tool: 'claude',
                toolName: tools[i % tools.length],
                timestamp: new Date(now - ((count - i) * 60 * 1000)).toISOString(),
            });
        }
        // Friction snapshot at Stop drives the score under the friction model.
        await appendEvent({
            type: 'stop',
            sessionId,
            tool: 'claude',
            timestamp: new Date(now).toISOString(),
            interventions: { interrupt: 2, toolReject: 0, toolError: 8 },
        });
    }

    it('hint explains that the current task is not covered when a knowledge gap is detected', async () => {
        const sessionId = 'knowledge-gap-hint-session';
        await seedHighScoreSession(sessionId);
        writeRecallCache(tmpDir, sessionId, {
            queries: ['q1'],
            count: 1,
            updatedAt: new Date().toISOString(),
            topScore: 0,
            hitCount: 0,
            missCount: 5,
        });

        const { hint } = await contributeCheckForSession(sessionId);
        expect(hint).not.toBeNull();
        expect(hint).toContain('The current task is not covered by the team knowledge base');
        expect(hint).toContain('you interrupted the AI twice');
        expect(hint).toContain('the AI retried failing tools 8 times');
    });

    it('knowledge gap can explain a frictionless hint without inventing friction reasons', async () => {
        const sessionId = 'knowledge-gap-only-hint-session';
        for (let i = 0; i < 15; i++) {
            await appendEvent({
                type: 'tool_use',
                sessionId,
                tool: 'claude',
                toolName: 'Bash',
                timestamp: new Date(Date.now() + i).toISOString(),
            });
        }
        writeRecallCache(tmpDir, sessionId, {
            queries: ['q1'],
            count: 1,
            updatedAt: new Date().toISOString(),
            topScore: 0,
            hitCount: 0,
            missCount: 1,
        });

        const { hint } = await contributeCheckForSession(sessionId);
        expect(hint).toContain('[teamai] The current task is not covered by the team knowledge base.');
        expect(hint).not.toContain('you interrupted the AI');
        expect(hint).not.toContain('you rejected');
        expect(hint).not.toContain('you corrected the AI');
        expect(hint).not.toContain('retried failing tools');
    });

    it('hint names the concrete friction signals when recall quality is good', async () => {
        const sessionId = 'good-recall-hint-session';
        await seedHighScoreSession(sessionId);
        writeRecallCache(tmpDir, sessionId, {
            queries: ['q1'],
            count: 1,
            updatedAt: new Date().toISOString(),
            topScore: 15.0,
            hitCount: 3,
            missCount: 0,
        });

        const { hint } = await contributeCheckForSession(sessionId);
        expect(hint).not.toBeNull();
        expect(hint).toContain('you interrupted the AI twice');
        expect(hint).toContain('the AI retried failing tools 8 times');
        expect(hint).not.toContain('you rejected');
        expect(hint).not.toContain('not covered by the team knowledge base');
    });
});
