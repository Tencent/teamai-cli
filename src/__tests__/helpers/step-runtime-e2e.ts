import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished } from 'vitest';
import { codexFake } from '@teamai/tool-codex/testing';
import { claudeProjectDirName } from '@teamai/tool-core/sessions/fs';
import { fakeAgent, type FakeAgent } from '@teamai/tool-testing/fake-agent';
import type { StepState } from '../../workflow/step-state.js';
import type { WorkflowEnvelope } from '../../workflow/types.js';

// What the E2E files of step runtimes share: the built CLI they run, how they read its envelope, and fake tools that
// keep their sessions in the home their variable names, laid out as the real tool does.

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CLI = path.join(ROOT, 'dist', 'index.js');

export interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runCLI(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...extraEnv, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export function attemptOf(step: StepState | undefined): string {
  const attempt = step && 'attempt' in step ? step.attempt : undefined;
  if (typeof attempt !== 'string') throw new Error(`step ${step?.id ?? '?'} has no attempt`);
  return attempt;
}

export function envelope(ran: Ran): WorkflowEnvelope {
  const line = ran.stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`no JSON envelope in stdout:\n${ran.stdout}\n${ran.stderr}`);
  return JSON.parse(line) as WorkflowEnvelope;
}

/** How a tool lays out a session in its store, as source the fake runs: the project directory of `process.cwd()`, and one record. */
export interface SessionLayout { readonly project: string; readonly record: string }

// Claude Code names a project after its cwd, each other character a `-`; a name over 200 characters is cut to 200 and
// gets `-` and its 32-bit string hash of the whole cwd in base 36, as a deep cwd such as a nested run's has.
export const CLAUDE_SESSIONS: SessionLayout = {
  project: `(${String(claudeProjectDirName)})(process.cwd())`,
  record: "{ type: 'user', sessionId: session, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'step' } }",
};
// CodeBuddy 2.173.0's encodeCwd for a short POSIX path, and its message record.
export const CODEBUDDY_SESSIONS: SessionLayout = {
  project: "process.cwd().replace(/[/:]/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-')",
  record: "{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'step' }], timestamp: Date.now() }",
};

/**
 * Codex on this test's PATH, in `bin`: the recorded `codexFake`, removed when the test finishes, which then fails if
 * one it started is still running.
 */
export function codexOnPath(bin: string): FakeAgent {
  const codex = fakeAgent(codexFake, { bin });

  onTestFinished(async () => {
    const left = await codex.stopLeft();

    for (const file of ['codex', 'codex.calls.jsonl', 'codex.pids']) fs.rmSync(path.join(bin, file), { force: true });
    expect(left, 'fake codex left running').toEqual([]);
  });

  return codex;
}

// A fake Claude Code or CodeBuddy: it writes its result, records how it was launched, keeps its session in the home its
// variable names, laid out as the tool does, and on --resume continues that session. Codex is `codexOnPath`, recorded;
// CodeBuddy has no recording (it is not installed where the recordings are made), so it keeps this script.
export const fakeTool = ({ tool, version, homeVariable, sessions }: { tool: string; version: string; homeVariable: string; sessions: SessionLayout }): string => `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('${version}\\n');
  process.exit(0);
}
if (process.env.TEAMAI_WORKFLOW_RESULT === undefined) {
  // A judge: it reads the prompt on stdin and answers with a label, under teamai-score's answer output. With
  // FAKE_TOOL_REPLY, it answers an answer step's one-shot call with that text instead.
  process.stdin.resume();
  const reply = process.env.FAKE_TOOL_REPLY === undefined ? { structured_output: { answer: { label: 'good', reasoning: 'read it' } } } : { result: process.env.FAKE_TOOL_REPLY };
  process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'result', ...reply }) + '\\n'));
  return;
}
const at = args.indexOf('--resume');
const resumed = at === -1 ? undefined : args[at + 1];
const session = resumed ?? 'sess-' + path.basename(process.env.TEAMAI_WORKFLOW_ATTEMPT);
// Without its variable, the tool keeps its sessions in the member's home, as on the local runtime.
const home = process.env.${homeVariable} ?? path.join(require('node:os').homedir(), '.${tool}');
const project = path.join(home, 'projects', ${sessions.project});
const file = path.join(project, session + '.jsonl');
const before = fs.existsSync(file);
fs.mkdirSync(project, { recursive: true });
fs.appendFileSync(file, JSON.stringify(${sessions.record}) + '\\n');
fs.appendFileSync(process.env.LAUNCHES, JSON.stringify({ home, resumed, sessionFoundBefore: before, secret: process.env.STEP_RUNTIME_SECRET ?? null }) + '\\n');
if (process.env.FAKE_TOOL_SPANS) fs.appendFileSync(process.env.FAKE_TOOL_SPANS, JSON.stringify({ attempt: process.env.TEAMAI_WORKFLOW_ATTEMPT, at: Date.now(), edge: 'start' }) + '\\n');
// It holds FAKE_TOOL_HOLD_MS, or, with FAKE_TOOL_BARRIER, until that many launches started, at most FAKE_TOOL_HOLD_MS.
const until = Date.now() + Number(process.env.FAKE_TOOL_HOLD_MS ?? 0);
const started = () => fs.readFileSync(process.env.FAKE_TOOL_SPANS, 'utf8').split('\\n').filter((line) => line.includes('"start"')).length;
while (Date.now() < until && !(process.env.FAKE_TOOL_BARRIER && started() >= Number(process.env.FAKE_TOOL_BARRIER))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (process.env.FAKE_TOOL_SPANS) fs.appendFileSync(process.env.FAKE_TOOL_SPANS, JSON.stringify({ attempt: process.env.TEAMAI_WORKFLOW_ATTEMPT, at: Date.now(), edge: 'end' }) + '\\n');
// With FAKE_TOOL_ERROR, it fails as a tool the provider refused does: an error result and status 1, with the value of the
// variable FAKE_TOOL_ERROR_ECHO names, as a tool that prints its token would.
if (process.env.FAKE_TOOL_ERROR) {
  const echoed = process.env.FAKE_TOOL_ERROR_ECHO ? ' ' + process.env[process.env.FAKE_TOOL_ERROR_ECHO] : '';
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: process.env.FAKE_TOOL_ERROR + echoed, session_id: session }) + '\\n');
  process.exit(1);
}
fs.mkdirSync(path.dirname(process.env.TEAMAI_WORKFLOW_RESULT), { recursive: true });
// With FAKE_TOOL_RESULT_ECHO, its result also holds the value of the variable it names, as an agent that writes its token.
fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { ok: true, ...(process.env.FAKE_TOOL_RESULT_ECHO && { echoed: process.env[process.env.FAKE_TOOL_RESULT_ECHO] }) } }));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-${tool}', session_id: session }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: session, usage: { input_tokens: 4, output_tokens: 2 } }) + '\\n');
`;
