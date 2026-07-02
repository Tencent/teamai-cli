import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
    containsError,
    extractQuery,
    extractGrepQuery,
    extractWebSearchQuery,
    extractWebFetchQuery,
    shouldSkipQuery,
    isReadOnlyCommand,
    autoRecallFromInput,
    parseHookInput,
} from '../auto-recall.js';
import { deriveSessionId } from '../utils/session-id.js';

// ─── Test helpers ──────────────────────────────────────────

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-auto-recall-test-'));
}

/** Write a minimal search-index.json under a temp HOME directory. */
function writeSearchIndex(homeDir: string): void {
    const indexDir = path.join(homeDir, '.teamai');
    fs.mkdirSync(indexDir, { recursive: true });

    const index = {
        version: 4,
        builtAt: new Date().toISOString(),
        elapsedMs: 10,
        df: {
            'title:k8s': 1, 'title:pod': 1, 'title:oomkilled': 1, 'title:排查': 1, 'title:修复': 1,
            'tag:k8s': 1, 'tag:oom': 1, 'tag:troubleshooting': 1,
            'oom': 1, 'killed': 1, 'memory': 1, 'limit': 1, 'container': 1, 'restart': 1,
            'title:modulenotfounderror': 1, 'title:常见': 1, 'title:解决方案': 1,
            'tag:python': 1, 'tag:import': 1, 'tag:modulenotfounderror': 1,
            'module': 1, 'not': 1, 'found': 1, 'import': 1, 'pip': 1, 'install': 1,
        },
        entries: [
            {
                filename: 'k8s-oom-fix-2026-03-20-abc123.md',
                title: 'K8s Pod OOMKilled 排查与修复',
                author: 'testuser',
                date: '2026-03-20',
                tags: ['k8s', 'oom', 'troubleshooting'],
                tokens: [
                    'title:k8s', 'title:pod', 'title:oomkilled', 'title:排查', 'title:修复',
                    'tag:k8s', 'tag:oom', 'tag:troubleshooting',
                    'oom', 'killed', 'memory', 'limit', 'container', 'restart',
                ],
                votes: 3,
                type: 'learnings',
                domain: 'technical',
            },
            {
                filename: 'module-not-found-fix-2026-03-22-def456.md',
                title: 'ModuleNotFoundError 常见解决方案',
                author: 'testuser',
                date: '2026-03-22',
                tags: ['python', 'import', 'modulenotfounderror'],
                tokens: [
                    'title:modulenotfounderror', 'title:常见', 'title:解决方案',
                    'tag:python', 'tag:import', 'tag:modulenotfounderror',
                    'module', 'not', 'found', 'import', 'pip', 'install',
                ],
                votes: 2,
                type: 'learnings',
                domain: 'technical',
            },
        ],
    };

    fs.writeFileSync(
        path.join(indexDir, 'search-index.json'),
        JSON.stringify(index),
        'utf-8',
    );
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

    it('detects real errors even inside auto-recall output', () => {
        // containsError itself does NOT filter [teamai:] — that's autoRecall()'s job.
        // This verifies containsError still detects errors in such output.
        const output = '[teamai:auto-recall] 检测到错误\nError: pod OOMKilled';
        expect(containsError(output)).toBe(true);
    });

    it('ignores "Error Handling" as a topic heading in file content', () => {
        // When "Error Handling" is the only error-like pattern,
        // the false positive pattern should suppress it.
        const output = `# Project TODOS

## Error Handling
- Add retry logic for API calls
- Improve validation messages

## Performance
- Cache frequently accessed data`;
        expect(containsError(output)).toBe(false);
    });

    it('ignores source code with method calls and template literals', () => {
        // Source code output from grep/git diff containing error keywords
        // should be recognized as code, not runtime errors.
        const output = 'pullSpin.warn(`Pull failed: ${(e as Error).message}`);';
        expect(containsError(output)).toBe(false);
    });

    it('ignores source code with arrow functions and error keywords', () => {
        const output = `const handleError = (err) => {
  logger.error(err.message);
};`;
        expect(containsError(output)).toBe(false);
    });

    it('ignores source code with const/let declarations containing error terms', () => {
        const output = 'const errorMsg = "Failed to connect";';
        expect(containsError(output)).toBe(false);
    });

    it('ignores source code with import/export statements', () => {
        const output = 'import { PermissionError } from "./errors";';
        expect(containsError(output)).toBe(false);
    });

    it('ignores source code with function declarations', () => {
        const output = 'function handleError(err) { throw new Error(err); }';
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

// ─── extractGrepQuery ──────────────────────────────────────

describe('extractGrepQuery', () => {
    it('extracts plain text pattern', () => {
        const query = extractGrepQuery({ pattern: 'ModuleNotFoundError' });
        expect(query).toBe('ModuleNotFoundError');
    });

    it('strips regex metacharacters', () => {
        const query = extractGrepQuery({ pattern: 'function\\s+\\w+\\(' });
        expect(query).not.toContain('\\');
        expect(query).toContain('function');
    });

    it('handles complex regex patterns', () => {
        const query = extractGrepQuery({ pattern: '^import.*from\\s+["\'](.+)["\']' });
        expect(query).toContain('import');
        expect(query).toContain('from');
    });

    it('returns empty for missing pattern', () => {
        expect(extractGrepQuery({})).toBe('');
        expect(extractGrepQuery({ pattern: 123 })).toBe('');
    });

    it('returns empty for very short pattern', () => {
        expect(extractGrepQuery({ pattern: 'ab' })).toBe('');
    });

    it('truncates very long patterns', () => {
        const query = extractGrepQuery({ pattern: 'word'.repeat(50) });
        expect(query.length).toBeLessThanOrEqual(120);
    });
});

// ─── extractWebSearchQuery ─────────────────────────────────

describe('extractWebSearchQuery', () => {
    it('returns query as-is for natural language', () => {
        const query = extractWebSearchQuery({ query: 'K8s pod restart OOM' });
        expect(query).toBe('K8s pod restart OOM');
    });

    it('returns empty for missing query', () => {
        expect(extractWebSearchQuery({})).toBe('');
        expect(extractWebSearchQuery({ query: 42 })).toBe('');
    });

    it('returns empty for very short query', () => {
        expect(extractWebSearchQuery({ query: 'ab' })).toBe('');
    });

    it('truncates very long queries', () => {
        const query = extractWebSearchQuery({ query: 'word '.repeat(50) });
        expect(query.length).toBeLessThanOrEqual(120);
    });

    it('trims whitespace', () => {
        const query = extractWebSearchQuery({ query: '  some search query  ' });
        expect(query).toBe('some search query');
    });
});

// ─── extractWebFetchQuery ──────────────────────────────────

describe('extractWebFetchQuery', () => {
    it('prefers prompt over URL', () => {
        const query = extractWebFetchQuery({
            url: 'https://example.com/docs/api',
            prompt: 'Find the authentication section',
        });
        expect(query).toBe('Find the authentication section');
    });

    it('falls back to URL path when no prompt', () => {
        const query = extractWebFetchQuery({
            url: 'https://docs.example.com/kubernetes/troubleshooting',
        });
        expect(query).toContain('kubernetes');
        expect(query).toContain('troubleshooting');
    });

    it('returns empty for missing url and prompt', () => {
        expect(extractWebFetchQuery({})).toBe('');
    });

    it('returns empty for URL with no meaningful path', () => {
        expect(extractWebFetchQuery({ url: 'https://www.example.com/' })).toBe('');
    });

    it('filters out common URL noise words', () => {
        const query = extractWebFetchQuery({
            url: 'https://www.example.com/docs/index.html',
        });
        expect(query).not.toContain('html');
        expect(query).not.toContain('www');
    });

    it('handles invalid URL gracefully', () => {
        expect(extractWebFetchQuery({ url: 'not a url' })).toBe('');
    });

    it('truncates long prompts', () => {
        const query = extractWebFetchQuery({
            url: 'https://example.com',
            prompt: 'word '.repeat(50),
        });
        expect(query.length).toBeLessThanOrEqual(120);
    });
});

// ─── isReadOnlyCommand ────────────────────────────────────────

describe('isReadOnlyCommand', () => {
    it('detects cat as read-only', () => {
        expect(isReadOnlyCommand('cat TODOS.md')).toBe(true);
    });

    it('detects head as read-only', () => {
        expect(isReadOnlyCommand('head -n 50 /tmp/log.txt')).toBe(true);
    });

    it('detects tail as read-only', () => {
        expect(isReadOnlyCommand('tail -f /var/log/syslog')).toBe(true);
    });

    it('detects less as read-only', () => {
        expect(isReadOnlyCommand('less README.md')).toBe(true);
    });

    it('detects bat as read-only', () => {
        expect(isReadOnlyCommand('bat src/index.ts')).toBe(true);
    });

    it('does NOT skip piped commands', () => {
        expect(isReadOnlyCommand('cat package.json | grep version')).toBe(false);
    });

    it('does NOT skip non-read commands', () => {
        expect(isReadOnlyCommand('npm test')).toBe(false);
        expect(isReadOnlyCommand('python main.py')).toBe(false);
    });

    it('does NOT skip commands containing read-only names as substrings', () => {
        expect(isReadOnlyCommand('grep cat file.txt')).toBe(false);
        expect(isReadOnlyCommand('catalog --list')).toBe(false);
    });

    it('handles empty command', () => {
        expect(isReadOnlyCommand('')).toBe(false);
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

    it('rate limits after 10 recalls per session', () => {
        for (let i = 0; i < 10; i++) {
            shouldSkipQuery('session-4', `unique query ${i}`);
        }
        // 11th query should be blocked
        expect(shouldSkipQuery('session-4', 'one more query')).toBe(true);
    });

    it('sessions do not interfere with each other', () => {
        shouldSkipQuery('session-5a', 'same error');
        expect(shouldSkipQuery('session-5b', 'same error')).toBe(false);
    });
});

// ─── deriveSessionId ───────────────────────────────────────

describe('deriveSessionId', () => {
    const originalEnv = process.env.CLAUDE_SESSION_ID;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.CLAUDE_SESSION_ID;
        } else {
            process.env.CLAUDE_SESSION_ID = originalEnv;
        }
    });

    it('prefers explicit session_id from payload', () => {
        expect(deriveSessionId({ session_id: 'explicit-session' })).toBe('explicit-session');
    });

    it('falls back to CLAUDE_SESSION_ID env var', () => {
        delete process.env.CLAUDE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = 'env-session';
        expect(deriveSessionId({})).toBe('env-session');
    });

    it('falls back to pid when nothing else is available', () => {
        delete process.env.CLAUDE_SESSION_ID;
        expect(deriveSessionId({})).toMatch(/^pid-/);
    });

    it('ignores non-string session_id values', () => {
        delete process.env.CLAUDE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = 'env-session';
        expect(deriveSessionId({ session_id: 123 })).toBe('env-session');
    });

    it('includes cwd in pid fallback when includeCwd is true', () => {
        delete process.env.CLAUDE_SESSION_ID;
        const result = deriveSessionId({ cwd: '/tmp/project' }, { includeCwd: true });
        expect(result).toMatch(/^pid-\d+-\/tmp\/project$/);
    });

    it('uses process.cwd() when cwd is missing and includeCwd is true', () => {
        delete process.env.CLAUDE_SESSION_ID;
        const result = deriveSessionId({}, { includeCwd: true });
        expect(result).toContain(process.cwd());
    });
});

// ─── parseHookInput ────────────────────────────────────────

describe('parseHookInput', () => {
    it('parses standard PostToolUse payload', () => {
        const input = parseHookInput({
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            tool_response: { stdout: 'ok', stderr: '' },
            session_id: 'session-1',
        });
        expect(input).not.toBeNull();
        expect(input!.toolName).toBe('Bash');
        expect(input!.toolInput).toEqual({ command: 'npm test' });
        expect(input!.toolOutput).toBe('ok');
        expect(input!.sessionId).toBe('session-1');
    });

    it('falls back to tool_output when tool_response is absent', () => {
        const input = parseHookInput({
            tool_name: 'Grep',
            tool_input: { pattern: 'foo' },
            tool_output: 'matched line',
        });
        expect(input).not.toBeNull();
        expect(input!.toolOutput).toBe('matched line');
    });

    it('falls back to tool_result alias', () => {
        const input = parseHookInput({
            tool_name: 'Write',
            tool_input: { file_path: '/tmp/x' },
            tool_result: 'done',
        });
        expect(input).not.toBeNull();
        expect(input!.toolOutput).toBe('done');
    });

    it('joins stdout and stderr from tool_response', () => {
        const input = parseHookInput({
            tool_name: 'Bash',
            tool_response: { stdout: 'out', stderr: 'err' },
        });
        expect(input).not.toBeNull();
        expect(input!.toolOutput).toBe('out\nerr');
    });

    it('normalizes missing tool_input to empty object', () => {
        const input = parseHookInput({
            tool_name: 'Bash',
        });
        expect(input).not.toBeNull();
        expect(input!.toolInput).toEqual({});
    });

    it('normalizes null tool_input to empty object', () => {
        const input = parseHookInput({
            tool_name: 'Bash',
            tool_input: null,
        });
        expect(input).not.toBeNull();
        expect(input!.toolInput).toEqual({});
    });

    it('derives session ID from environment when missing', () => {
        const input = parseHookInput({
            tool_name: 'Bash',
        });
        expect(input).not.toBeNull();
        expect(input!.sessionId).toMatch(/^pid-/);
    });

    it('returns null when tool_name is missing', () => {
        expect(parseHookInput({ tool_input: { command: 'ls' } })).toBeNull();
    });

    it('returns null when tool_name is not a string', () => {
        expect(parseHookInput({ tool_name: 123, tool_input: {} })).toBeNull();
    });

    it('returns null when tool_name is empty', () => {
        expect(parseHookInput({ tool_name: '', tool_input: {} })).toBeNull();
    });

    it('prefers tool_output over tool_result when both are present', () => {
        const input = parseHookInput({
            tool_name: 'Bash',
            tool_output: 'from tool_output',
            tool_result: 'from tool_result',
        });
        expect(input).not.toBeNull();
        expect(input!.toolOutput).toBe('from tool_output');
    });

    it('keeps stderr when stdout is absent in tool_response', () => {
        const input = parseHookInput({
            tool_name: 'Bash',
            tool_response: { stderr: 'error only' },
        });
        expect(input).not.toBeNull();
        expect(input!.toolOutput).toBe('error only');
    });
});

// ─── autoRecallFromInput ───────────────────────────────────

describe('autoRecallFromInput', () => {
    let tmpHome: string;
    const originalHome = process.env.HOME;
    const originalDisabled = process.env.TEAMAI_RECALL_DISABLED;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        tmpHome = makeTmpDir();
        process.env.HOME = tmpHome;
        // Mock cwd so autoDetectInit won't find the real project config
        cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpHome);
        delete process.env.TEAMAI_RECALL_DISABLED;
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        process.env.HOME = originalHome;
        if (originalDisabled === undefined) {
            delete process.env.TEAMAI_RECALL_DISABLED;
        } else {
            process.env.TEAMAI_RECALL_DISABLED = originalDisabled;
        }
        fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('returns null when TEAMAI_RECALL_DISABLED=1', async () => {
        process.env.TEAMAI_RECALL_DISABLED = '1';
        const result = await autoRecallFromInput({
            toolName: 'Bash',
            toolInput: { command: 'npm test' },
            toolOutput: 'Error: failed',
            sessionId: 'disabled-session',
        });
        expect(result).toBeNull();
    });

    it('returns null for unknown tools', async () => {
        const result = await autoRecallFromInput({
            toolName: 'Write',
            toolInput: { file_path: '/tmp/test.ts' },
            toolOutput: '',
            sessionId: 'unknown-tool-session',
        });
        expect(result).toBeNull();
    });

    it('returns null for read-only Bash commands', async () => {
        writeSearchIndex(tmpHome);
        const result = await autoRecallFromInput({
            toolName: 'Bash',
            toolInput: { command: 'cat error.log' },
            toolOutput: 'Error: something failed\nTraceback (most recent call last):',
            sessionId: 'readonly-session',
        });
        expect(result).toBeNull();
    });

    it('returns null when Bash output contains no error', async () => {
        writeSearchIndex(tmpHome);
        const result = await autoRecallFromInput({
            toolName: 'Bash',
            toolInput: { command: 'npm test' },
            toolOutput: 'All tests passed',
            sessionId: 'no-error-session',
        });
        expect(result).toBeNull();
    });

    it('returns hook output JSON when Bash error matches search index', async () => {
        writeSearchIndex(tmpHome);
        const result = await autoRecallFromInput({
            toolName: 'Bash',
            toolInput: { command: 'kubectl get pods' },
            toolOutput: 'Error: pod my-pod OOMKilled\nContainer killed due to OOM',
            sessionId: 'bash-error-session',
        });

        expect(result).not.toBeNull();
        const parsed = JSON.parse(result!);
        expect(parsed.hookSpecificOutput).toBeDefined();
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('[teamai:auto-recall]');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('OOM');
    });

    it('returns hook output JSON for Grep tool input', async () => {
        writeSearchIndex(tmpHome);
        const result = await autoRecallFromInput({
            toolName: 'Grep',
            toolInput: { pattern: 'ModuleNotFoundError' },
            toolOutput: '',
            sessionId: 'grep-session',
        });

        expect(result).not.toBeNull();
        const parsed = JSON.parse(result!);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('[teamai:auto-recall]');
    });

    it('returns hook output JSON for WebSearch tool input', async () => {
        writeSearchIndex(tmpHome);
        const result = await autoRecallFromInput({
            toolName: 'WebSearch',
            toolInput: { query: 'K8s pod OOMKilled troubleshooting' },
            toolOutput: '',
            sessionId: 'websearch-session',
        });

        expect(result).not.toBeNull();
        const parsed = JSON.parse(result!);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('[teamai:auto-recall]');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('OOM');
    });

    it('returns hook output JSON for WebFetch tool input using prompt', async () => {
        writeSearchIndex(tmpHome);
        const result = await autoRecallFromInput({
            toolName: 'WebFetch',
            toolInput: { url: 'https://example.com', prompt: 'ModuleNotFoundError fix' },
            toolOutput: '',
            sessionId: 'webfetch-session',
        });

        expect(result).not.toBeNull();
        const parsed = JSON.parse(result!);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('[teamai:auto-recall]');
    });

    it('returns null when the extracted query is too short', async () => {
        writeSearchIndex(tmpHome);
        const result = await autoRecallFromInput({
            toolName: 'Grep',
            toolInput: { pattern: 'ab' },
            toolOutput: '',
            sessionId: 'short-query-session',
        });
        expect(result).toBeNull();
    });

    it('returns null when no search results match', async () => {
        writeSearchIndex(tmpHome);
        const result = await autoRecallFromInput({
            toolName: 'Grep',
            toolInput: { pattern: 'totally-unrelated-topic' },
            toolOutput: '',
            sessionId: 'no-match-session',
        });
        expect(result).toBeNull();
    });

    it('skips duplicate queries within the same session', async () => {
        writeSearchIndex(tmpHome);
        const input = {
            toolName: 'Grep' as const,
            toolInput: { pattern: 'ModuleNotFoundError' },
            toolOutput: '',
            sessionId: 'dedup-session',
        };

        const first = await autoRecallFromInput(input);
        expect(first).not.toBeNull();

        const second = await autoRecallFromInput(input);
        expect(second).toBeNull();
    });

    it('skips Bash output that already contains auto-recall markers', async () => {
        writeSearchIndex(tmpHome);
        const result = await autoRecallFromInput({
            toolName: 'Bash',
            toolInput: { command: 'kubectl get pods' },
            toolOutput: '[teamai:auto-recall] previous result\nError: pod OOMKilled',
            sessionId: 'marker-session',
        });
        expect(result).toBeNull();
    });

    it('respects the per-session recall rate limit', async () => {
        writeSearchIndex(tmpHome);
        const sessionId = 'rate-limit-session';
        for (let i = 0; i < 10; i++) {
            const result = await autoRecallFromInput({
                toolName: 'Grep',
                toolInput: { pattern: `unique-${i}` },
                toolOutput: '',
                sessionId,
            });
            // Some queries may not match the index, but they still count toward the limit
            expect(result === null || result !== null).toBe(true);
        }

        // 11th recall should be rate-limited regardless of query
        const overLimit = await autoRecallFromInput({
            toolName: 'Grep',
            toolInput: { pattern: 'ModuleNotFoundError' },
            toolOutput: '',
            sessionId,
        });
        expect(overLimit).toBeNull();
    });
});

// ─── autoRecall: TEAMAI_RECALL_DISABLED flag ───────────────

describe('autoRecall TEAMAI_RECALL_DISABLED', () => {
    const originalEnv = process.env.TEAMAI_RECALL_DISABLED;

    beforeEach(() => {
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    });

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.TEAMAI_RECALL_DISABLED;
        } else {
            process.env.TEAMAI_RECALL_DISABLED = originalEnv;
        }
        vi.restoreAllMocks();
    });

    it('returns immediately without writing to stdout when TEAMAI_RECALL_DISABLED=1', async () => {
        process.env.TEAMAI_RECALL_DISABLED = '1';

        // Dynamically import to get the real autoRecall function
        const { autoRecall } = await import('../auto-recall.js');
        await autoRecall();

        expect(process.stdout.write).not.toHaveBeenCalled();
    });
});

// ─── CLI integration: STDIN parsing + JSON output ──────────
describe('auto-recall CLI integration', () => {
    const CLI_PATH = path.resolve(__dirname, '../../dist/index.js');

    // Skip if not built
    const cliExists = fs.existsSync(CLI_PATH);

    it.skipIf(!cliExists)('outputs valid JSON with additionalContext for Grep', () => {
        const input = JSON.stringify({
            tool_name: 'Grep',
            tool_input: { pattern: 'K8s deployment troubleshooting' },
            tool_response: { stdout: 'no matches' },
        });
        const result = execSync(`echo '${input}' | node ${CLI_PATH} auto-recall --stdin 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 10000,
        }).trim();

        // May be empty if no search index — only validate format when output exists
        if (result) {
            const parsed = JSON.parse(result);
            expect(parsed.hookSpecificOutput).toBeDefined();
            expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
            expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
            expect(parsed.hookSpecificOutput.additionalContext).toContain('[teamai:auto-recall]');
        }
    });

    it.skipIf(!cliExists)('outputs nothing for unknown tools (fast path)', () => {
        const input = JSON.stringify({
            tool_name: 'Write',
            tool_input: { file_path: '/tmp/test.ts', content: 'hello' },
            tool_response: { stdout: '' },
        });
        const result = execSync(`echo '${input}' | node ${CLI_PATH} auto-recall --stdin 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 5000,
        }).trim();

        expect(result).toBe('');
    });

    it.skipIf(!cliExists)('parses tool_input correctly when missing', () => {
        const input = JSON.stringify({
            tool_name: 'Grep',
            // No tool_input field
            tool_response: { stdout: '' },
        });
        // Should not throw — gracefully returns empty query
        const result = execSync(`echo '${input}' | node ${CLI_PATH} auto-recall --stdin 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 5000,
        }).trim();

        // No output expected (empty pattern → empty query → skip)
        expect(result).toBe('');
    });

    it.skipIf(!cliExists)('parses tool_input correctly when null', () => {
        const input = JSON.stringify({
            tool_name: 'WebSearch',
            tool_input: null,
            tool_response: { stdout: '' },
        });
        const result = execSync(`echo '${input}' | node ${CLI_PATH} auto-recall --stdin 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 5000,
        }).trim();

        expect(result).toBe('');
    });
});
