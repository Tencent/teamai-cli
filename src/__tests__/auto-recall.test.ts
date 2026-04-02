import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    containsError,
    extractQuery,
    shouldSkipQuery,
} from '../auto-recall.js';

// ─── Test helpers ──────────────────────────────────────────

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-auto-recall-test-'));
}

// ─── containsError ─────────────────────────────────────────

describe('containsError', () => {
    it('detects Python traceback', () => {
        const output = `Traceback (most recent call last):
  File "main.py", line 10, in <module>
    raise ValueError("bad input")
ValueError: bad input`;
        expect(containsError(output)).toBe(true);
    });

    it('detects "Error:" pattern', () => {
        expect(containsError('error: failed to compile module')).toBe(true);
    });

    it('detects "Failed" pattern', () => {
        expect(containsError('Build Failed with exit code 1')).toBe(true);
    });

    it('detects ENOENT', () => {
        expect(containsError('ENOENT: no such file or directory')).toBe(true);
    });

    it('detects "command not found"', () => {
        expect(containsError('bash: kubectl: command not found')).toBe(true);
    });

    it('detects "Permission denied"', () => {
        expect(containsError('Permission denied (publickey)')).toBe(true);
    });

    it('detects "exit code" with non-zero', () => {
        expect(containsError('Process exited with exit code 1')).toBe(true);
    });

    it('detects ModuleNotFoundError', () => {
        expect(containsError('ModuleNotFoundError: No module named "torch"')).toBe(true);
    });

    it('detects Go panic', () => {
        expect(containsError('panic: runtime error: index out of range')).toBe(true);
    });

    it('detects OOM', () => {
        expect(containsError('Container killed due to OOM')).toBe(true);
    });

    // ─── False positives (should NOT trigger) ────────────

    it('ignores normal git status output', () => {
        const output = `On branch main
modified:   src/index.ts
modified:   package.json`;
        expect(containsError(output)).toBe(false);
    });

    it('ignores error-related variable names in code', () => {
        const output = `const error_handling = require('./error_handling');
const errorHandler = new ErrorHandler();
const error_code = getErrorCode();`;
        expect(containsError(output)).toBe(false);
    });

    it('ignores "0 errors" output', () => {
        expect(containsError('Build succeeded: 0 errors, 2 warnings')).toBe(false);
    });

    it('ignores empty output', () => {
        expect(containsError('')).toBe(false);
    });

    it('ignores normal successful output', () => {
        expect(containsError('Successfully compiled 42 files')).toBe(false);
    });

    it('ignores catch/try blocks in code', () => {
        const output = `try {
  const result = await fetch(url);
} catch (error) {
  console.log(error);
}`;
        expect(containsError(output)).toBe(false);
    });

    it('ignores JSON key "error":', () => {
        const output = '{"error": null, "data": {"id": 1}}';
        expect(containsError(output)).toBe(false);
    });
});

// ─── extractQuery ──────────────────────────────────────────

describe('extractQuery', () => {
    it('extracts query from Python error', () => {
        const output = `Traceback (most recent call last):
  File "main.py", line 10, in <module>
ModuleNotFoundError: No module named 'sglang'`;
        const query = extractQuery(output);
        expect(query).toContain('ModuleNotFoundError');
        expect(query).toContain('sglang');
    });

    it('extracts query from bash error', () => {
        const output = 'bash: kubectl: command not found';
        const query = extractQuery(output);
        expect(query).toContain('command not found');
    });

    it('strips file paths from query', () => {
        const output = 'Error: Cannot find module /home/user/project/src/missing.js';
        const query = extractQuery(output);
        expect(query).not.toContain('/home/user');
    });

    it('strips ANSI codes from query', () => {
        const output = '\x1b[31mError: something failed\x1b[0m';
        const query = extractQuery(output);
        expect(query).not.toContain('\x1b');
        expect(query).toContain('Error');
    });

    it('returns empty string for very short output', () => {
        expect(extractQuery('Er')).toBe('');
    });

    it('truncates very long queries', () => {
        const longError = 'Error: ' + 'a'.repeat(200);
        const query = extractQuery(longError);
        expect(query.length).toBeLessThanOrEqual(120);
    });
});

// ─── shouldSkipQuery (dedup + rate limiting) ───────────────

describe('shouldSkipQuery', () => {
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

    it('allows first query in a session', () => {
        expect(shouldSkipQuery('session-1', 'ModuleNotFoundError torch')).toBe(false);
    });

    it('blocks duplicate query in same session', () => {
        shouldSkipQuery('session-2', 'ENOENT missing file');
        expect(shouldSkipQuery('session-2', 'ENOENT missing file')).toBe(true);
    });

    it('allows different queries in same session', () => {
        shouldSkipQuery('session-3', 'query one');
        expect(shouldSkipQuery('session-3', 'query two')).toBe(false);
    });

    it('rate limits after 5 recalls per session', () => {
        for (let i = 0; i < 5; i++) {
            shouldSkipQuery('session-4', `unique query ${i}`);
        }
        // 6th query should be blocked
        expect(shouldSkipQuery('session-4', 'one more query')).toBe(true);
    });

    it('sessions do not interfere with each other', () => {
        shouldSkipQuery('session-5a', 'same error');
        expect(shouldSkipQuery('session-5b', 'same error')).toBe(false);
    });
});
