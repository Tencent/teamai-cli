import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { attemptOf, CLAUDE_SESSIONS, CLI, envelope, fakeTool, runCLI, type Ran } from '../helpers/step-runtime-e2e.js';

// `--driver local`, the member's default driver, as a member runs it: what its runs record and how they end, which the
// split of the host command slot from the runtime that launches tools keeps as it was.

describe('the local driver, end to end', () => {
  let sandbox: string;
  let repo: string;
  let bare: string;
  let bin: string;
  let launches: string;
  const dataHomes = new Map<string, string>();

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LAUNCHES: launches, ...extra });

  const writeFlow = (at: string, name: string, steps: string): void => {
    fs.mkdirSync(path.join(at, '.teamai', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(at, '.teamai', 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${name}\nsteps:\n${steps}\n`);
  };

  const runsOf = (at: string): string => path.join(dataHomes.get(at) ?? '', 'workflows', 'runs');

  const runIds = (at = repo): Set<string> => new Set(fs.existsSync(runsOf(at))
    ? fs.readdirSync(runsOf(at)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length))
    : []);

  const readRunState = (runId: string, at = repo): RunState => JSON.parse(fs.readFileSync(path.join(runsOf(at), `${runId}.json`), 'utf8')) as RunState;

  const launched = (): Array<{ resumed?: string }> => (fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { resumed?: string }) : []);

  const initRepo = async (at: string, args: string[]): Promise<void> => {
    fs.mkdirSync(at);
    fs.writeFileSync(path.join(at, 'README.md'), '# fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: at });
    execFileSync('git', ['add', 'README.md'], { cwd: at });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: at });
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], { cwd: at });
    const initialized = await runCLI(['init', '--self', ...args, '--force'], at);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    const origin = `${at}.git`;
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: at });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: at });
  };

  beforeAll(async () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-local-tools-e2e-')));
    repo = path.join(sandbox, 'repo');
    bare = path.join(sandbox, 'bare');
    bin = path.join(sandbox, 'fake-bin');
    launches = path.join(sandbox, 'launches.jsonl');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), fakeTool({ tool: 'claude', version: '2.1.0 (Claude Code)', homeVariable: 'CLAUDE_CONFIG_DIR', sessions: CLAUDE_SESSIONS }), { mode: 0o755 });
    await initRepo(repo, ['--agent', 'claude']);
    await initRepo(bare, []);
    for (const at of [repo, bare]) dataHomes.set(at, await resolveProjectDataHome(at));
    writeFlow(repo, 'oneprompt', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
    writeFlow(repo, 'twoprompts', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean
  - id: recall
    needs: [review]
    session: { from: review }
    prompt: Say what you reviewed.
    output:
      ok: boolean`);
    writeFlow(repo, 'sealed', `  - id: sealed
    prompt: Review the repository in a sandbox.
    requires: { isolation: sandbox, strict: true }
    output:
      ok: boolean`);
    const folder = path.join(repo, '.teamai', 'workflows', 'foldered');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'WORKFLOW.yaml'), `schemaVersion: v1alpha1
name: foldered
description: Reads a file of its folder, asks about it, then reviews.
steps:
  - id: read
    command: node "$TEAMAI_WORKFLOW_DIR/read.js"
    output: { note: string }
  - id: ask
    needs: [read]
    answer_file: ask.md
    output: { text: string }
  - id: review
    needs: [ask]
    prompt_file: review.md
    output: { ok: boolean }
`);
    fs.writeFileSync(path.join(folder, 'read.js'), "const fs = require('node:fs');\nconst path = require('node:path');\nprocess.stdout.write(JSON.stringify({ note: fs.readFileSync(path.join(process.env.TEAMAI_WORKFLOW_DIR, 'note.txt'), 'utf8').trim() }));\n");
    fs.writeFileSync(path.join(folder, 'note.txt'), 'carried by the folder\n');
    fs.writeFileSync(path.join(folder, 'ask.md'), 'Name one risk in this repository.\n');
    fs.writeFileSync(path.join(folder, 'review.md'), 'Review the repository without changing it.\n');
    writeFlow(bare, 'oneprompt', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);

    for (const at of [repo, bare]) {
      const pulled = await runCLI(['pull'], at);
      expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    }
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** The data home the run records go to, found from the run teamai just started. */
  const runOf = (ran: Ran, before: Set<string>, at = repo): string => {
    const runId = [...runIds(at)].find((id) => !before.has(id));
    if (runId === undefined) throw new Error(`no new run:\n${ran.stdout}\n${ran.stderr}`);

    return runId;
  };

  it('resumes a run whose teamai was killed while its headless prompt ran, runs the step to the end, and frees the login the killed attempt held', async () => {
    fs.rmSync(launches, { force: true });
    const before = runIds();
    const child = spawn(process.execPath, [CLI, 'workflow', 'start', 'oneprompt', '--driver', 'local', '--tools', 'default=claude'], { cwd: repo, env: { ...process.env, ...env({ FAKE_TOOL_HOLD_MS: '10000' }), FORCE_COLOR: '0' }, stdio: 'ignore' });
    const deadline = Date.now() + 30_000;

    while (launched().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launched()).toHaveLength(1);
    const ended = new Promise((resolve) => child.on('close', resolve));
    child.kill('SIGKILL');
    await ended;

    const runId = [...runIds()].find((id) => !before.has(id));
    // The Codex login lock a judge in the killed process held: nothing of that attempt runs once teamai stops what it left.
    const [killed] = readRunState(String(runId)).steps;
    const lock = path.join(os.homedir(), '.teamai', 'logins', 'codex.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ run: runId, attempt: killed && 'lease' in killed ? killed.lease.attempt : '', takenAt: new Date().toISOString() }));

    const resumed = await runCLI(['workflow', 'resume', String(runId), '--driver', 'local', '--tools', 'default=claude'], repo, env());

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(readRunState(String(runId)).steps).toMatchObject([{ id: 'review', status: 'succeeded', tool: 'claude', outputs: { ok: true } }]);
    // The resumed teamai launched the step again: the tool the killed one started does not report.
    expect(launched()).toHaveLength(2);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('frees the login a killed attempt held when its step timed out before teamai resumed the run', async () => {
    writeFlow(repo, 'timedprompt', `  - id: review
    prompt: Review the repository without changing it.
    timeout: 2s
    output:
      ok: boolean`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    fs.rmSync(launches, { force: true });
    const before = runIds();
    const child = spawn(process.execPath, [CLI, 'workflow', 'start', 'timedprompt', '--driver', 'local', '--tools', 'default=claude'], { cwd: repo, env: { ...process.env, ...env({ FAKE_TOOL_HOLD_MS: '10000' }), FORCE_COLOR: '0' }, stdio: 'ignore' });
    const deadline = Date.now() + 30_000;

    while (launched().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const ended = new Promise((resolve) => child.on('close', resolve));
    child.kill('SIGKILL');
    await ended;
    const runId = String([...runIds()].find((id) => !before.has(id)));
    const [killed] = readRunState(runId).steps;
    const lock = path.join(os.homedir(), '.teamai', 'logins', 'codex.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ run: runId, attempt: killed && 'lease' in killed ? killed.lease.attempt : '', takenAt: new Date().toISOString() }));
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'local', '--tools', 'default=claude'], repo, env());

    expect(fs.existsSync(lock), `${resumed.stdout}\n${resumed.stderr}`).toBe(false);
  });

  it('writes back the Codex login a killed teamai\'s judge refreshed when the person cancels the run', async () => {
    fs.rmSync(launches, { force: true });
    const before = runIds();
    const child = spawn(process.execPath, [CLI, 'workflow', 'start', 'oneprompt', '--driver', 'local', '--tools', 'default=claude'], { cwd: repo, env: { ...process.env, ...env({ FAKE_TOOL_HOLD_MS: '10000' }), FORCE_COLOR: '0' }, stdio: 'ignore' });
    const deadline = Date.now() + 30_000;

    while (launched().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const ended = new Promise((resolve) => child.on('close', resolve));
    child.kill('SIGKILL');
    await ended;
    const runId = String([...runIds()].find((id) => !before.has(id)));
    const [killed] = readRunState(runId).steps;
    const attempt = killed && 'lease' in killed ? killed.lease.attempt : '';
    // The killed teamai's Codex judge copied the member's login into the attempt's own Codex home, where Codex refreshed it.
    const daily = path.join(sandbox, 'daily-codex');
    const login = (refresh: string): string => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'acct-1', refresh_token: refresh } });
    fs.mkdirSync(daily, { recursive: true });
    fs.writeFileSync(path.join(daily, 'auth.json'), login('refresh-1'), { mode: 0o600 });
    const toolHome = path.join(runsOf(repo), runId, 'attempts', attempt, 'tool-home', 'codex');
    fs.mkdirSync(toolHome, { recursive: true });
    fs.writeFileSync(path.join(toolHome, 'auth.json'), login('refresh-2'));
    const lock = path.join(os.homedir(), '.teamai', 'logins', 'codex.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ run: runId, attempt, takenAt: new Date().toISOString(), from: { home: daily, signIn: `CODEX_HOME=${daily} codex login` }, copied: createHash('sha256').update(login('refresh-1')).digest('hex') }));

    const cancelled = await runCLI(['workflow', 'cancel', runId], repo, env());

    expect({ daily: JSON.parse(fs.readFileSync(path.join(daily, 'auth.json'), 'utf8')).tokens.refresh_token, locked: fs.existsSync(lock) }, `${cancelled.stdout}\n${cancelled.stderr}`)
      .toEqual({ daily: 'refresh-2', locked: false });
  });

  it('resumes the earlier step\'s session in a session.from step, with no notice and no place held', async () => {
    fs.rmSync(launches, { force: true });
    const before = runIds();

    const ran = await runCLI(['workflow', 'start', 'twoprompts', '--driver', 'local', '--tools', 'default=claude'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran, before);
    const [review, recall] = readRunState(runId).steps;
    const session = review && 'session' in review ? review.session : undefined;
    expect(recall).toMatchObject({ status: 'succeeded', resumed: { tool: 'claude', id: session } });
    expect(launched().map((launch) => launch.resumed)).toEqual([undefined, session]);
    expect(ran.stderr).not.toContain('did not continue');
    // Each attempt recorded that it ran in teamai's process, and none kept an external runtime's record, as a place held
    // for a conversation keeps one.
    const attempts = path.join(runsOf(repo), runId, 'attempts');
    const records = fs.readdirSync(attempts).map((attempt): unknown => JSON.parse(fs.readFileSync(path.join(attempts, attempt, 'runtime.json'), 'utf8')));
    expect(records).toEqual([{ runtime: 'tools', driver: 'teamai-local', inProcess: true }, { runtime: 'tools', driver: 'teamai-local', inProcess: true }]);
  });

  it('runs a workflow folder\'s command, answer and prompt steps from its own files, on the host slot, the host slot and tools', async () => {
    const before = runIds();

    const ran = await runCLI(['workflow', 'start', 'foldered', '--driver', 'local', '--tools', 'default=claude'], repo, env({ FAKE_TOOL_REPLY: 'Unpinned dependencies.' }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran, before);
    expect(readRunState(runId).steps).toMatchObject([
      { id: 'read', status: 'succeeded', outputs: { note: 'carried by the folder' } },
      { id: 'ask', status: 'succeeded', outputs: { text: 'Unpinned dependencies.' } },
      { id: 'review', status: 'succeeded', tool: 'claude', outputs: { ok: true } },
    ]);
    const records = readRunState(runId).steps.map((step): unknown => JSON.parse(fs.readFileSync(path.join(runsOf(repo), runId, 'attempts', attemptOf(step), 'runtime.json'), 'utf8')));
    expect(records).toEqual([
      { runtime: 'host', driver: 'teamai-local', inProcess: true },
      { runtime: 'host', driver: 'teamai-local', inProcess: true },
      { runtime: 'tools', driver: 'teamai-local', inProcess: true },
    ]);
  });

  it('refuses a strict sandbox step with the text the local driver always gave', async () => {
    const ran = await runCLI(['workflow', 'start', 'sealed', '--driver', 'local'], repo, env());

    expect(envelope(ran)).toMatchObject({ error: { message: 'Step "sealed" requires strict isolation, and the local driver here is not a sandbox. Run it in CI or a container, and declare it with --sandbox or workflows.sandbox: true.' } });
  });

  it('fails an unattended prompt step with no tool set, naming the three places one is set', async () => {
    const before = runIds(bare);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'local'], bare, env({ TEAMAI_AI_TOOL: '' }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(readRunState(runOf(ran, before, bare), bare).steps).toMatchObject([{ status: 'failed', failure: {
      code: 'tool_unconfigured',
      message: expect.stringContaining('Name one with the step\'s tool:, with --tools default=<tool>, or with ai.tool in your teamai config'),
    } }]);
  });
});
