import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── E2E tests for `teamai auto-recall --stdin` ──────────────
//
// These tests invoke the real CLI binary as a subprocess, with $HOME
// pointing to a temp directory containing a minimal search index.
// This exercises the full pipeline:
//
//   STDIN (hook JSON) → autoRecall() → dispatch → containsError/extractQuery
//   → search(index) → STDOUT (additionalContext JSON) / silence
//

const CLI_PATH = path.resolve(__dirname, '../../dist/index.js');

function makeTmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-auto-recall-e2e-'));
}

/** Write a minimal search-index.json that will match OOM/K8s queries. */
function writeSearchIndex(homeDir: string): void {
    const indexDir = path.join(homeDir, '.teamai');
    fs.mkdirSync(indexDir, { recursive: true });

    const index = {
        builtAt: new Date().toISOString(),
        elapsedMs: 10,
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
            },
        ],
    };

    fs.writeFileSync(
        path.join(indexDir, 'search-index.json'),
        JSON.stringify(index),
        'utf-8',
    );
}

/** Run `teamai auto-recall --stdin` as subprocess. */
function runAutoRecall(
    homeDir: string,
    stdinPayload: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';

        const child = execFile(
            'node',
            [CLI_PATH, 'auto-recall', '--stdin'],
            {
                env: { ...process.env, HOME: homeDir, TEAMAI_LOG_LEVEL: 'silent' },
                timeout: 10000,
            },
            (_error, out, err) => {
                // Capture buffered output from the callback (most reliable source)
                stdout = out ?? '';
                stderr = err ?? '';
            },
        );

        child.stdin?.write(stdinPayload);
        child.stdin?.end();

        // Wait for 'close' so child.exitCode is guaranteed to be set.
        // The execFile callback fires on 'exit' which can race with stdio
        // drain; 'close' fires after both exit + stdio close.
        child.on('close', (exitCode) => {
            resolve({
                stdout,
                stderr,
                code: exitCode ?? 0,
            });
        });
    });
}

// ─── Tests ──────────────────────────────────────────────

describe('auto-recall E2E', () => {
    let tmpHome: string;

    beforeEach(() => {
        tmpHome = makeTmpHome();
        writeSearchIndex(tmpHome);
    });

    afterEach(() => {
        fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    // ─── Scenario 1: Bash error triggers search ────────────

    it('outputs additionalContext when Bash output contains a real error', async () => {
        const input = JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'kubectl get pods' },
            tool_output: 'Error: pod my-pod OOMKilled\nContainer killed due to OOM',
            session_id: 'e2e-bash-error',
        });

        const { stdout, code } = await runAutoRecall(tmpHome, input);

        expect(code).toBe(0);
        expect(stdout).not.toBe('');

        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput).toBeDefined();
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('[teamai:auto-recall]');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('OOM');
    });

    // ─── Scenario 2: read-only command skipped ─────────────

    it('produces no output for read-only commands even with error content', async () => {
        const input = JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'cat error.log' },
            tool_output: 'Error: something failed\nTraceback (most recent call last):',
            session_id: 'e2e-readonly',
        });

        const { stdout, code } = await runAutoRecall(tmpHome, input);

        expect(code).toBe(0);
        expect(stdout.trim()).toBe('');
    });

    // ─── Scenario 3: non-whitelisted tool skipped ──────────

    it('produces no output for non-whitelisted tools', async () => {
        const input = JSON.stringify({
            tool_name: 'Read',
            tool_input: { file_path: '/tmp/test.ts' },
            tool_output: 'Error: file not found\nFATAL crash',
            session_id: 'e2e-nonwhitelisted',
        });

        const { stdout, code } = await runAutoRecall(tmpHome, input);

        expect(code).toBe(0);
        expect(stdout.trim()).toBe('');
    });

    // ─── Scenario 4: pipe command is NOT read-only ─────────

    it('triggers search for piped commands containing errors', async () => {
        const input = JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'cat logs.txt | grep OOM' },
            tool_output: 'Error: container OOM Killed - exceeded memory limit',
            session_id: 'e2e-pipe-cmd',
        });

        const { stdout, code } = await runAutoRecall(tmpHome, input);

        expect(code).toBe(0);
        // Piped commands are not read-only, so should trigger
        expect(stdout).not.toBe('');
        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.additionalContext).toContain('[teamai:auto-recall]');
    });

    // ─── Scenario 5: auto-recall own output does NOT trigger ──

    it('does not trigger on auto-recall own output markers', async () => {
        const input = JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'teamai recall K8s' },
            tool_output: [
                '[teamai:auto-recall] 检测到错误，自动搜索团队知识库',
                'Error: pod OOMKilled',
                '[teamai:recall:start]',
                'K8s Pod OOMKilled 排查与修复',
                '[teamai:recall:end]',
            ].join('\n'),
            session_id: 'e2e-self-output',
        });

        const { stdout, code } = await runAutoRecall(tmpHome, input);

        expect(code).toBe(0);
        expect(stdout.trim()).toBe('');
    });

    // ─── Scenario 6: Grep tool triggers search ─────────────

    it('outputs additionalContext for Grep tool with matching query', async () => {
        const input = JSON.stringify({
            tool_name: 'Grep',
            tool_input: { pattern: 'OOMKilled' },
            tool_response: { stdout: 'some grep results' },
            session_id: 'e2e-grep-trigger',
        });

        const { stdout, code } = await runAutoRecall(tmpHome, input);

        expect(code).toBe(0);
        expect(stdout).not.toBe('');

        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.additionalContext).toContain('[teamai:auto-recall]');
    });

    // ─── Scenario 7: dedup skips duplicate query ───────────

    it('skips duplicate query in the same session', async () => {
        const makeInput = () => JSON.stringify({
            tool_name: 'Grep',
            tool_input: { pattern: 'OOMKilled' },
            tool_response: { stdout: 'results' },
            session_id: 'e2e-dedup-session',
        });

        // First call — should produce output
        const first = await runAutoRecall(tmpHome, makeInput());
        expect(first.code).toBe(0);
        expect(first.stdout).not.toBe('');

        // Second call — same session + same query → should be silent (dedup)
        const second = await runAutoRecall(tmpHome, makeInput());
        expect(second.code).toBe(0);
        expect(second.stdout.trim()).toBe('');
    });
});
