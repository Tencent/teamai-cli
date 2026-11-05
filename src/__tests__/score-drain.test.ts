import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: async () => null,
}));

import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { ATTEMPT_ENV, type RunMode } from '../launch-context.js';
import { saveLocalConfig } from '../config.js';
import { dataHomeKey } from '../dashboard-collector.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { LabelStore } from '../scorers/label-store.js';
import { scoreCommand, type ScoreOptions } from '../score-commands.js';
import { Drain } from '../score-drain.js';
import YAML from 'yaml';
import { z } from 'zod';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { getReportsDir, REPORTS_LOCK_FILENAME, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { log } from '../utils/logger.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import * as cliPaths from '../utils/cli-path.js';
import { leaseNext, parseReport, reportAttempt, startRun } from '../workflow/engine.js';
import { projectRun } from '../workflow/snapshot.js';
import { readRun, readRuns } from '../workflow/store.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { runShortcut, workflowResume, workflowStart } from '../workflow-commands.js';

const SCORER = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
sessions: true
---
Judge the session.
`;

const WORKFLOW = `schemaVersion: v1alpha1
name: review
description: One reviewed step.
steps:
  - id: review
    prompt: Review the change.
    scorers: [quality]
`;

const SESSION = '7c1e0000-0000-4000-8000-000000000011';
const STEP_SESSION = '7c1e0000-0000-4000-8000-000000000021';
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const HOUR = 60 * 60 * 1000;

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-drain-')));
  mocks.home = path.join(root, 'home');
  fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(mocks.home, '.gitconfig'), '[user]\n\tname = tester\n\temail = tester@example.com\n[gc]\n\tauto = 0\n');
  for (const name of AGENT_SESSION_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HOME', mocks.home);
  vi.stubEnv('USERPROFILE', mocks.home);
  // No judge tool of this machine: a test that judges puts its fake one first.
  vi.stubEnv('PATH', ['/usr/bin', '/bin'].join(path.delimiter));
  // Login shells can add system tool directories even with this isolated HOME.
  vi.spyOn(cliPaths, 'resolveCliPath').mockImplementation((cmd) => {
    const fixture = path.join(root, 'bin', cmd);
    return fs.existsSync(fixture) ? fixture : null;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A git-kind team whose repo holds `files`, cloned and saved as this machine's user install, with its scorers cached. */
async function team(files: Record<string, string> = {}): Promise<{ origin: string; config: LocalConfig }> {
  const seed = path.join(root, 'seed');
  for (const [file, text] of Object.entries({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\n', 'scorers/quality.md': SCORER, ...files })) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), text);
  }
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'team');
  const origin = path.join(root, 'team.git');
  git(root, 'clone', '-q', '--bare', seed, origin);
  const clone = path.join(root, 'team');
  git(root, 'clone', '-q', origin, clone);
  const config: LocalConfig = { repo: { localPath: clone, remote: origin, kind: 'git' }, username: 'tester', scope: 'user', additionalRoles: [] };
  await saveLocalConfig(config);
  await syncScorerDefinitions(config);
  return { origin, config };
}

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

/** Writes the Claude session `sessionId` that ran in `<root>/app`, whose answer is `answer`, and returns its file. */
function claudeSession(sessionId: string, answer: string): string {
  const cwd = path.join(root, 'app');
  fs.mkdirSync(cwd, { recursive: true });
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  fs.writeFileSync(file,
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Add retries to the client' } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId, timestamp: '2026-10-20T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: answer }] } }));
  return file;
}

/**
 * A Claude session `sessionId` in `<root>/app` whose answer is `answer`, captured in the user scope's data home in
 * `runMode`, with nothing happening in it for `idleFor`.
 */
function capturedSession(sessionId: string, runMode: RunMode, { idleFor = 7 * HOUR, answer = 'Added the retries.' } = {}): void {
  const file = claudeSession(sessionId, answer);
  const idleSince = new Date(Date.now() - idleFor);
  fs.utimesSync(file, idleSince, idleSince);
  const captures = path.join(mocks.home, '.teamai', 'sessions', 'captures', 'claude-code', sessionId);
  fs.mkdirSync(captures, { recursive: true });
  const captureId = `0b6f2a52-5d7e-4c7e-9a43-${sessionId.slice(-12)}`;
  fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId,
    capturedAt: idleSince.toISOString(), runMode, agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file }));
}

/** A Claude judge on PATH that answers good, or with `fails` exits 1 without an answer. */
function fakeClaude({ fails = false, version = '2.1.308 (Claude Code)' } = {}): void {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(); }
${fails ? 'process.exit(1);' : ''}
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'good', reasoning: 'the reasoning' } }));
});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', [bin, '/usr/bin', '/bin'].join(path.delimiter));
}

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

/** Runs the review workflow in `config` to its end, its steps settled in order by `reports` as an external driver would. */
async function settledRun(config: LocalConfig, runMode: RunMode, ...reports: Record<string, unknown>[]): Promise<string> {
  await syncScorersThenWorkflows(config);
  const checkout = path.join(root, 'app');
  fs.mkdirSync(checkout, { recursive: true });
  const runId = String(data(await startRun(config, 'review', {}, { secrets: {}, runMode, checkout })).run);
  const driver = { kind: 'external', machine: 'm1', workspace: checkout };
  for (const report of reports.length > 0 ? reports : [{}]) {
    const lease = data(await leaseNext(config, runId, driver, { runMode })).lease;
    const { attempt, revision } = lease as { attempt: string; revision: number };
    const parsed = parseReport({ attempt, revision, outcome: 'success', driver, outputs: {}, ...report });
    if (typeof parsed === 'string') throw new Error(parsed);
    data(await reportAttempt(config, runId, parsed.report));
  }
  expect(data(await leaseNext(config, runId, driver))).toMatchObject({ done: { outcome: 'succeeded' } });
  return runId;
}

/** The files under `dir` on teamai-reports of bare repository `origin`. */
function onReports(origin: string, dir: string): string[] {
  try {
    return execFileSync('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'teamai-reports', ...(dir ? [dir] : [])], { encoding: 'utf8', stdio: 'pipe' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The text of `file` on teamai-reports of bare repository `origin`. */
function readOnReports(origin: string, file: string): string {
  return execFileSync('git', ['--git-dir', origin, 'show', `teamai-reports:${file}`], { encoding: 'utf8', stdio: 'pipe' });
}

const MARK = `schemaVersion: v1alpha1
name: mark
description: One command.
steps:
  - id: mark
    command: echo marked
`;

/** Runs `run`, a local `workflow start` or `resume`, in `<root>/app` and returns its envelope, exit code and log lines. */
async function driveLocally(run: () => Promise<void>): Promise<{ envelope: unknown; code: number; lines: string[] }> {
  const work = path.join(root, 'app');
  fs.mkdirSync(work, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(work);
  const lines: string[] = [];
  let out = '';
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  process.exitCode = 0;
  try {
    await run();
    return { envelope: JSON.parse(out), code: Number(process.exitCode ?? 0), lines };
  } finally {
    vi.mocked(process.stdout.write).mockRestore();
    vi.mocked(console.error).mockRestore();
    vi.mocked(process.cwd).mockRestore();
    process.exitCode = 0;
  }
}

/** Runs `teamai score --drain` and returns its exit code and the lines it printed. */
async function drain(): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const print = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(print);
  vi.spyOn(console, 'error').mockImplementation(print);
  process.exitCode = 0;
  try {
    await scoreCommand({ drain: true });
    return { code: Number(process.exitCode ?? 0), lines };
  } finally {
    vi.mocked(console.log).mockRestore();
    vi.mocked(console.error).mockRestore();
    process.exitCode = 0;
  }
}

describe('teamai score --drain', () => {
  it('says nothing is left and exits 0 when there is nothing to do here', async () => {
    await team();

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('✔ Nothing left to do here');
  });

  it('warns once, and writes nothing into the repository, for a project whose teamai data is still inside it', async () => {
    const { config } = await team();
    const checkout = path.join(root, 'app');
    fs.mkdirSync(checkout, { recursive: true });
    const legacy: LocalConfig = { ...config, scope: 'project', projectRoot: checkout, dataHome: path.join(checkout, '.teamai') };
    fakeClaude();
    const warnings: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });

    await Drain.run([legacy], { mode: 'attended' });

    expect(warnings.filter((printed) => printed.includes('Scoring is off for this project'))).toHaveLength(1);
    expect(fs.existsSync(path.join(checkout, '.teamai', 'scores'))).toBe(false);
  });

  it('exits 1 when it cannot publish, and the next drain publishes what stayed pending', async () => {
    const { origin, config } = await team();
    await LabelStore.append(config, [{ label: {
      scorer: 'quality', rubric: { sourceHash: 'h1' }, label: 'good', score: 1, passed: true,
      source: 'session', subject: { platform: 'claude-code', sessionId: SESSION }, judge: { kind: 'human' }, scoredAt: new Date().toISOString(),
    }, reasoning: 'Did the work.' }]);
    vi.stubEnv('CI', 'true');
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "push refused" >&2\nexit 1\n', { mode: 0o755 });

    const failed = await drain();

    expect(failed.code, failed.lines.join('\n')).toBe(1);
    expect(failed.lines.filter((printed) => printed.startsWith('✖'))).toEqual([
      expect.stringMatching(/^✖ Could not publish 1 label to teamai-reports: [\s\S]*push refused[\s\S]*\. It stays pending; run teamai score --drain again\.$/),
    ]);
    expect(failed.lines.join('\n').split('push refused')).toHaveLength(2);
    expect(onReports(origin, '')).toEqual([]);

    fs.rmSync(hook);
    const again = await drain();

    expect(again.code, again.lines.join('\n')).toBe(0);
    expect(again.lines).toContain('✔ Published 1 label to teamai-reports');
    expect(onReports(origin, 'scores')).toHaveLength(1);
  });

  it('says the cause ssh gives when it cannot publish, in one sentence', async () => {
    const { config } = await team();
    await LabelStore.append(config, [{ label: {
      scorer: 'quality', rubric: { sourceHash: 'h1' }, label: 'good', score: 1, passed: true,
      source: 'session', subject: { platform: 'claude-code', sessionId: SESSION }, judge: { kind: 'human' }, scoredAt: new Date().toISOString(),
    }, reasoning: 'Did the work.' }]);
    fakeClaude();
    vi.stubEnv('CI', 'true');
    const ssh = path.join(root, 'bin', 'ssh-denied');
    fs.writeFileSync(ssh, '#!/bin/sh\necho "git@example.invalid: Permission denied (publickey)." >&2\nexit 255\n', { mode: 0o755 });
    vi.stubEnv('GIT_SSH_COMMAND', ssh);
    execFileSync('git', ['-C', config.repo.localPath, 'config', 'remote.origin.pushurl', 'git@example.invalid:acme/team.git']);

    const failed = await drain();

    expect(failed.code, failed.lines.join('\n')).toBe(1);
    expect(failed.lines.filter((printed) => printed.startsWith('✖ Could not publish'))).toEqual([
      '✖ Could not publish 1 label to teamai-reports: git@example.invalid: Permission denied (publickey).; fatal: Could not read from remote repository.; '
        + 'Please make sure you have the correct access rights; and the repository exists. It stays pending; run teamai score --drain again.',
    ]);
  });

  it('says that another process is writing teamai-reports', async () => {
    const { config } = await team();
    await LabelStore.append(config, [{ label: {
      scorer: 'quality', rubric: { sourceHash: 'h1' }, label: 'good', score: 1, passed: true,
      source: 'session', subject: { platform: 'claude-code', sessionId: SESSION }, judge: { kind: 'human' }, scoredAt: new Date().toISOString(),
    }, reasoning: 'Did the work.' }]);
    vi.stubEnv('CI', 'true');
    const lock = path.join(path.dirname(getReportsDir(config)), REPORTS_LOCK_FILENAME);
    expect(await acquireLock(lock)).toBe(true);
    let drained: Awaited<ReturnType<typeof drain>>;
    try {
      drained = await drain();
    } finally {
      await releaseLock(lock);
    }

    expect(drained.code, drained.lines.join('\n')).toBe(1);
    expect(drained.lines, drained.lines.join('\n')).toContain('✖ Could not publish 1 label to teamai-reports: another teamai process is writing teamai-reports. It stays pending; run teamai score --drain again.');
  });

  it('publishes the workflow run records a run could not publish to teamai-reports', async () => {
    const { origin, config } = await team({ 'workflows/review.yaml': WORKFLOW.replace('    scorers: [quality]\n', '') });
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "push refused" >&2\nexit 1\n', { mode: 0o755 });
    const runId = await settledRun(config, 'unattended');
    fs.rmSync(hook);

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('✔ Published 1 workflow run record to teamai-reports');
    expect(onReports(origin, 'workflows/runs')).toEqual([`workflows/runs/${runId}.json`]);

    const again = await drain();

    expect(again).toEqual({ code: 0, lines: ['✔ Nothing left to do here'] });
  });

  it('exits 1 while a workflow run record still cannot reach teamai-reports, and the next drain publishes it', async () => {
    const { origin, config } = await team({ 'workflows/review.yaml': WORKFLOW.replace('    scorers: [quality]\n', '') });
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "push refused" >&2\nexit 1\n', { mode: 0o755 });
    const runId = await settledRun(config, 'unattended');

    const failed = await drain();

    expect(failed.code, failed.lines.join('\n')).toBe(1);
    expect(failed.lines.filter((printed) => printed.startsWith('✖'))).toEqual([
      expect.stringMatching(/^✖ Could not publish 1 workflow run record to teamai-reports: [^\n]*remote: push refused; error: failed to push some refs[^\n]*\. It stays pending; run teamai score --drain again\.$/),
    ]);

    fs.rmSync(hook);
    const again = await drain();

    expect(again.code, again.lines.join('\n')).toBe(0);
    expect(onReports(origin, 'workflows/runs')).toEqual([`workflows/runs/${runId}.json`]);
  });

  it('masks the value of a secret the team declares, whatever its name, in the step sessions it archives', async () => {
    const dsn = 'mysql-prod-7Hq2xVb9Lk';
    const { origin, config } = await team({ 'env/secrets.yaml': 'secrets:\n  - key: WAREHOUSE_DSN\n', 'workflows/review.yaml': WORKFLOW.replace('    scorers: [quality]\n', '') });
    vi.stubEnv('WAREHOUSE_DSN', dsn);
    claudeSession(STEP_SESSION, `Reviewed it against ${dsn}.`);
    await settledRun(config, 'unattended', { tool: 'claude', session: STEP_SESSION });
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    const archived = onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'));
    expect(archived).toHaveLength(1);
    const texts = archived.map((file) => readOnReports(origin, file));
    expect(texts.join('\n')).toContain('Reviewed it against');
    for (const text of texts) expect(text).not.toContain(dsn);
  });

  it('archives the step sessions of the runs it drives in this mode once, scrubbed, and lists once a pass whose tool it reads no sessions from', async () => {
    const { origin, config } = await team({ 'workflows/review.yaml': WORKFLOW.replace('    scorers: [quality]\n', '') });
    claudeSession(STEP_SESSION, `Reviewed it. The deploy token is ${TOKEN}.`);
    const archivedRun = await settledRun(config, 'unattended', { tool: 'claude', session: STEP_SESSION });
    const skippedRun = await settledRun(config, 'unattended', { tool: 'copilot', session: 'copilot-1' });
    await settledRun(config, 'attended', { tool: 'claude', session: '7c1e0000-0000-4000-8000-000000000022' });
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toEqual(expect.arrayContaining([
      `✔ Archived 1 step session of ${archivedRun} to teamai-reports (scrubbed)`,
      `ℹ Skipped 1 step session of ${skippedRun}: teamai reads no sessions from copilot (review, pass 1)`,
    ]));
    const [archived, ...more] = onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'));
    expect(more).toEqual([]);
    expect(readOnReports(origin, archived)).toContain('Reviewed it.');
    expect(readOnReports(origin, archived)).not.toContain(TOKEN);

    const again = await drain();

    expect(again).toEqual({ code: 0, lines: ['✔ Nothing left to do here'] });
  });

  it('says the step sessions of one run it cannot find here in one line, whichever sessions they are', async () => {
    const { config } = await team({ 'workflows/review.yaml': `${WORKFLOW.replace('    scorers: [quality]\n', '')}  - id: check\n    needs: [review]\n    prompt: Check the change.\n` });
    const runId = await settledRun(config, 'unattended', { tool: 'claude', session: '7c1e0000-0000-4000-8000-000000000031' }, { tool: 'claude', session: '7c1e0000-0000-4000-8000-000000000032' });
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines.filter((said) => said.includes('Skipped'))).toEqual([
      `ℹ Skipped 2 step sessions of ${runId}: claude-code could not read these sessions here (not found), so they stay unarchived (review, pass 1; check, pass 1)`,
    ]);
  });

  it('says the step sessions of one run it cannot read here in one line, though they fail for different reasons', async () => {
    const { config } = await team({ 'workflows/review.yaml': `${WORKFLOW.replace('    scorers: [quality]\n', '')}  - id: check\n    needs: [review]\n    prompt: Check the change.\n` });
    const missing = '7c1e0000-0000-4000-8000-000000000041';
    const broken = '7c1e0000-0000-4000-8000-000000000042';
    fs.chmodSync(claudeSession(broken, 'Checked it.'), 0o000);
    const runId = await settledRun(config, 'unattended', { tool: 'claude', session: missing }, { tool: 'claude', session: broken });
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines.filter((said) => said.includes('Skipped'))).toEqual([
      `ℹ Skipped 2 step sessions of ${runId}: claude-code could not read these sessions here (not found, unreadable), so they stay unarchived (review, pass 1; check, pass 1)`,
    ]);
  });

  it('says the step sessions of one run it cannot read here in one line, though different tools ran them', async () => {
    const { config } = await team({ 'workflows/review.yaml': `${WORKFLOW.replace('    scorers: [quality]\n', '')}  - id: check\n    needs: [review]\n    prompt: Check the change.\n` });
    const runId = await settledRun(config, 'unattended', { tool: 'claude', session: '7c1e0000-0000-4000-8000-000000000051' }, { tool: 'codex', session: '7c1e0000-0000-4000-8000-000000000052' });
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    const skipped = drained.lines.filter((said) => said.includes('Skipped'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(new RegExp(`^ℹ Skipped 2 step sessions of ${runId}: these sessions could not be read here \\(claude-code: [^;]+; codex: [^)]+\\), so they stay unarchived \\(review, pass 1; check, pass 1\\)$`));
  });

  it('archives no session of a step of a private sub-workflow, and still archives the other step sessions of its run', async () => {
    const judge = 'schemaVersion: v1alpha1\nname: judge\ndescription: Judge the review on this machine only.\nprivate: true\nsteps:\n  - id: label\n    prompt: Judge it.\n';
    const review = WORKFLOW.replace('    scorers: [quality]\n', '  - id: judge\n    needs: [review]\n    workflow: judge\n');
    const { origin, config } = await team({ 'workflows/review.yaml': review, 'workflows/judge.yaml': judge });
    const judgeSession = '7c1e0000-0000-4000-8000-000000000031';
    claudeSession(STEP_SESSION, 'Reviewed it.');
    claudeSession(judgeSession, 'Judged it good.');
    const reviewed = await settledRun(config, 'unattended', { tool: 'claude', session: STEP_SESSION }, { tool: 'claude', session: judgeSession });
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain(`✔ Archived 1 step session of ${reviewed} to teamai-reports (scrubbed)`);
    const archived = onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'));
    expect(archived).toHaveLength(1);
    expect(archived.map((file) => readOnReports(origin, file)).join('\n')).not.toContain('Judged it good.');
  });

  it('lists once, with why, a step session it cannot read here, and still archives the readable step sessions of its run', async () => {
    const { origin, config } = await team({ 'workflows/review.yaml': `${WORKFLOW.replace('    scorers: [quality]\n', '')}  - id: check\n    needs: [review]\n    prompt: Check the change.\n` });
    const unreadable = '7c1e0000-0000-4000-8000-000000000023';
    claudeSession(STEP_SESSION, 'Reviewed it.');
    const runId = await settledRun(config, 'unattended', { tool: 'claude', session: STEP_SESSION }, { tool: 'claude', session: unreadable });
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toEqual(expect.arrayContaining([
      `✔ Archived 1 step session of ${runId} to teamai-reports (scrubbed)`,
      `ℹ Skipped 1 step session of ${runId}: claude-code could not read this session here (not found), so it stays unarchived (check, pass 1)`,
    ]));
    expect(onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'))).toHaveLength(1);

    const again = await drain();

    expect(again).toEqual({ code: 0, lines: ['✔ Nothing left to do here'] });
  });

  it('reports the usage of an unattended session to stats/<member>.yaml under unattended, on a data home that never ran pull', async () => {
    const { origin } = await team();
    const key = await dataHomeKey(path.join(mocks.home, '.teamai'));
    const at = (minute: number) => new Date(Date.now() - (60 - minute) * 60 * 1000).toISOString();
    const events = [['session_start', at(0)], ['prompt_submit', at(1)], ['stop', at(2)]].map(([type, timestamp]) => line({
      type, timestamp, sessionId: SESSION, tool: 'claude', cwd: path.join(root, 'app'), dataHomeKey: key, runMode: 'unattended', ...(type === 'prompt_submit' ? { promptSummary: 'Add retries' } : {}),
    }));
    fs.mkdirSync(path.join(mocks.home, '.teamai', 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(mocks.home, '.teamai', 'dashboard', 'events.jsonl'), events.join(''));
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('✔ Reported usage to stats/tester.yaml');
    expect(YAML.parse(readOnReports(origin, 'stats/tester.yaml'))).toMatchObject({ unattended: { interventions: { sessions: 1 }, prompts: 1 } });
  });

  it('exits 1 and says the usage stays on this machine when teamai-reports refuses its report', async () => {
    const { origin } = await team();
    const key = await dataHomeKey(path.join(mocks.home, '.teamai'));
    fs.mkdirSync(path.join(mocks.home, '.teamai', 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(mocks.home, '.teamai', 'dashboard', 'events.jsonl'), line({
      type: 'session_start', timestamp: new Date(Date.now() - HOUR).toISOString(), sessionId: SESSION, tool: 'claude', cwd: path.join(root, 'app'), dataHomeKey: key, runMode: 'unattended',
    }));
    fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "push refused" >&2\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(1);
    expect(drained.lines).toContain('✖ Could not report usage to stats/tester.yaml on teamai-reports. It stays on this machine; run teamai score --drain again.');
    expect(onReports(origin, 'stats')).toEqual([]);
  });

  it('counts what an unattended session delivered when the drain ends its job, before it has been idle for 6 hours (#1387)', async () => {
    const { origin } = await team();
    const key = await dataHomeKey(path.join(mocks.home, '.teamai'));
    const at = (minute: number) => new Date(Date.now() - (60 - minute) * 60 * 1000).toISOString();
    const event = (type: string, minute: number) => line({
      type, timestamp: at(minute), sessionId: SESSION, tool: 'claude', cwd: path.join(root, 'app'), dataHomeKey: key, runMode: 'unattended',
    });
    const attended = line({
      type: 'session_start', timestamp: at(0), sessionId: '7c1e0000-0000-4000-8000-000000000031', tool: 'claude', cwd: path.join(root, 'app'), dataHomeKey: key, runMode: 'attended',
    });
    fs.mkdirSync(path.join(mocks.home, '.teamai', 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(mocks.home, '.teamai', 'dashboard', 'events.jsonl'), [event('session_start', 0), event('stop', 2), attended].join(''));
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(YAML.parse(readOnReports(origin, 'stats/tester.yaml')).outcomes).toEqual({ unattended: { none: { sessions: 1, tokens: { input: 0, output: 0 }, interventions: 0 } } });
  });

  it('counts the commits the session that runs the drain made since its last Stop (#1387)', async () => {
    const { origin } = await team();
    const app = path.join(root, 'driven-app');
    fs.mkdirSync(app);
    git(app, 'init', '-q', '-b', 'main');
    git(app, 'commit', '-q', '--allow-empty', '-m', 'start');
    const start = git(app, 'rev-parse', 'HEAD');
    const key = await dataHomeKey(path.join(mocks.home, '.teamai'));
    const at = (minute: number) => new Date(Date.now() - (60 - minute) * 60 * 1000).toISOString();
    const event = (type: string, minute: number) => line({
      type, timestamp: at(minute), sessionId: SESSION, tool: 'claude', cwd: app, dataHomeKey: key, runMode: 'unattended',
      ...(type === 'session_start' ? { gitAtStart: { head: start } } : { gitHead: start, gitBranch: 'main' }),
    });
    fs.mkdirSync(path.join(mocks.home, '.teamai', 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(mocks.home, '.teamai', 'dashboard', 'events.jsonl'), [event('session_start', 0), event('stop', 2)].join(''));
    // The turn that runs the drain commits first; its Stop comes after the drain.
    git(app, 'commit', '-q', '--allow-empty', '-m', 'retries');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', SESSION);
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(YAML.parse(readOnReports(origin, 'stats/tester.yaml')).outcomes).toEqual({ unattended: { commit: { sessions: 1, tokens: { input: 0, output: 0 }, interventions: 0 } } });
  });

  it('says only that nothing is left when a second drain finds nothing new, usage included', async () => {
    await team({ 'scorers/quality.md': SCORER.replace('sessions: true\n', '') });
    const key = await dataHomeKey(path.join(mocks.home, '.teamai'));
    fs.mkdirSync(path.join(mocks.home, '.teamai', 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(mocks.home, '.teamai', 'dashboard', 'events.jsonl'), line({
      type: 'session_start', timestamp: new Date(Date.now() - HOUR).toISOString(), sessionId: SESSION, tool: 'claude', cwd: path.join(root, 'app'), dataHomeKey: key, runMode: 'unattended',
    }));
    vi.stubEnv('CI', 'true');
    expect((await drain()).lines).toContain('✔ Reported usage to stats/tester.yaml');

    const again = await drain();

    expect(again).toEqual({ code: 0, lines: ['✔ Nothing left to do here'] });
  });

  it('with unattended: off in teamai.yaml and scoring.yaml, neither judges nor archives an unattended job\'s sessions', async () => {
    const { origin, config } = await team({
      'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { unattended: off }\n',
      'scorers/scoring.yaml': 'sessions: { unattended: off }\n',
      'workflows/review.yaml': WORKFLOW.replace('    scorers: [quality]\n', ''),
    });
    capturedSession(SESSION, 'unattended');
    claudeSession(STEP_SESSION, 'Reviewed it.');
    await settledRun(config, 'unattended', { tool: 'claude', session: STEP_SESSION });
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines.filter((printed) => /Judged|Published|Archived/.test(printed))).toEqual([]);
    expect(await LabelStore.local(config)).toEqual([]);
    expect(onReports(origin, 'sessions')).toEqual([]);
  });

  it('in attended mode with no settings, neither archives nor judges an attended session idle six hours', async () => {
    const { origin, config } = await team();
    capturedSession(SESSION, 'attended');
    fakeClaude();

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines.filter((printed) => /Judged|Archived/.test(printed))).toEqual([]);
    expect(await LabelStore.local(config)).toEqual([]);
    expect(onReports(origin, 'sessions')).toEqual([]);
  });

  it('says what its run judged, failed, left for CI and could not archive, through the teamai-score and teamai-share-session step ids, and exits 1', async () => {
    const groups = [
      { subject: `session:claude-code:${SESSION}`, labels: { labels: [{ scorer: 'quality', code: '' }] } },
      { subject: `session:claude-code:${STEP_SESSION}`, labels: { labels: [{ scorer: 'quality', code: 'ci_pending' }] } },
      { subject: 'run:r1:review:1', labels: { labels: [{ scorer: 'quality', code: 'judge_failed' }, { scorer: 'depth', code: 'judge_failed' }] } },
      { subject: 'team-session:alice:2026-10-20-s1', labels: { labels: [{ scorer: 'quality', code: '' }] } },
    ];
    // A team's own teamai-finished-sessions, whose steps answer as teamai score plan, label and write and teamai session push would.
    const { config } = await team({ 'workflows/teamai-finished-sessions.yaml': `schemaVersion: v1alpha1
name: teamai-finished-sessions
description: Stands in for the shipped one.
invoke: deny
private: true
inputs:
  publish: policy | always | never
  scorers: [string]
steps:
  - id: rescore
    workflow:
      steps:
        - id: plan
          command: echo '${JSON.stringify({ groups })}'
          output: { groups: [{ subject: string, labels: { labels: [{ scorer: string, code: string }] } }] }
        - id: score
          needs: [plan]
          for_each: steps.plan.outputs.groups
          workflow:
            steps:
              - id: judge
                command: echo judged
              - id: label
                needs: [judge]
                command: printf '%s' "$LABELS"
                env: { LABELS: "{{ item.labels }}" }
                output: { labels: [{ scorer: string, code: string }] }
              - id: write
                needs: [label]
                command: echo written
  - id: share
    needs: [rescore]
    workflow:
      steps:
        - id: publish
          command: echo "push refused" >&2; exit 1
` });
    await syncScorersThenWorkflows(config);
    capturedSession(SESSION, 'unattended');
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(1);
    expect(drained.lines).toEqual(expect.arrayContaining([
      '✔ Judged 1 sampled session here (quality)',
      '✖ quality, depth on pass 1 of step review in run r1: judge_failed. A failed judgment is final and is not retried. To ask for a new one: teamai score --run r1 --step review --pass 1 --scorer quality --scorer depth',
      expect.stringMatching(/^✖ Could not publish 1 session to teamai-reports: .*push refused.*It stays pending; run teamai score --drain again\.$/su),
      expect.stringMatching(/^✖ Run \S+ of teamai-finished-sessions failed: step share failed\.$/u),
      'ℹ Left open: 1 session whose CI has not finished. The next teamai score --drain labels them once it has.',
    ]));
    expect(drained.lines.filter((printed) => printed.includes('Judged'))).toHaveLength(1);
  });

  it('says a judgment whose label the write step did not store, or whose group broke before it labelled, failed, naming the step, and exits 1', async () => {
    const groups = [
      { subject: `session:claude-code:${SESSION}`, scorers: 'quality', labels: { labels: [{ scorer: 'quality', code: '' }] } },
      { subject: `session:claude-code:${STEP_SESSION}`, scorers: 'depth', labels: 'not labels' },
      { subject: `session:claude-code:${SESSION}`, scorers: 'delivered', labels: { labels: [{ scorer: 'delivered', code: 'ci_pending' }] } },
    ];
    // As the shipped teamai-score runs when another process holds the label store: label gives the label, write refuses it.
    const { config } = await team({ 'workflows/teamai-finished-sessions.yaml': `schemaVersion: v1alpha1
name: teamai-finished-sessions
description: Stands in for the shipped one.
invoke: deny
private: true
inputs:
  publish: policy | always | never
  scorers: [string]
steps:
  - id: rescore
    continue_on_failure: true
    workflow:
      steps:
        - id: plan
          command: echo '${JSON.stringify({ groups })}'
          output: { groups: [{ subject: string, scorers: string, labels: json }] }
        - id: score
          needs: [plan]
          for_each: steps.plan.outputs.groups
          continue_on_failure: true
          workflow:
            steps:
              - id: judge
                command: echo judged
              - id: label
                needs: [judge]
                command: printf '%s' "$LABELS"
                env: { LABELS: "{{ item.labels }}" }
                output: { labels: [{ scorer: string, code: string }] }
              - id: write
                needs: [label]
                command: "echo 'busy: Another teamai process holds the label store, so no label was written. Run the step again.' >&2; exit 1"
` });
    await syncScorersThenWorkflows(config);
    capturedSession(SESSION, 'unattended');
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(1);
    expect(drained.lines.filter((printed) => /Judged|Nothing left|Left open/u.test(printed))).toEqual([]);
    expect(drained.lines).toContainEqual(expect.stringMatching(new RegExp(`^✖ delivered on claude-code session ${SESSION}: score_step_failed \\(step rescore\\.score\\[2\\]\\.write failed: `, 'u')));
    expect(drained.lines).toContainEqual(expect.stringMatching(new RegExp(`^✖ depth on claude-code session ${STEP_SESSION}: score_step_failed \\(step rescore\\.score\\[1\\]\\.label failed: .+\\)\\. A failed judgment is final`, 'u')));
    expect(drained.lines).toContainEqual(expect.stringMatching(new RegExp(`^✖ quality on claude-code session ${SESSION}: score_step_failed \\(step rescore\\.score\\[0\\]\\.write failed: command exited with status 1: busy: Another teamai process holds the label store, so no label was written\\. Run the step again\\)\\. A failed judgment is final`, 'u')));
  });

  it('leaves open, with the command that takes them, the judges no tool here can take, and the next drain leaves the run to its driver', async () => {
    const { config } = await team({ 'workflows/teamai-finished-sessions.yaml': `schemaVersion: v1alpha1
name: teamai-finished-sessions
description: Stands in for the shipped one.
invoke: deny
private: true
inputs:
  publish: policy | always | never
  scorers: [string]
steps:
  - id: rescore
    workflow:
      steps:
        - id: plan
          command: echo '${JSON.stringify({ groups: [{ subject: `session:claude-code:${SESSION}` }, { subject: `session:claude-code:${STEP_SESSION}` }] })}'
          output: { groups: [{ subject: string }] }
        - id: score
          needs: [plan]
          for_each: steps.plan.outputs.groups
          workflow:
            steps:
              - id: evidence
                command: |
                  "${process.execPath}" -e "const p=require('path'),fs=require('fs'),d=p.join(process.env.TEAMAI_RUN_DIR,'evidence');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'confined.json'),'{\\"level\\":\\"verified\\"}')"
              - id: judge
                needs: [evidence]
                workspace: { confined: evidence }
                prompt: Judge the session from the files here.
                output: { answer: json }
` });
    await syncScorersThenWorkflows(config);
    capturedSession(SESSION, 'unattended');
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    const [left, ...more] = drained.lines.filter((printed) => printed.startsWith('ℹ Left open'));
    expect(more).toEqual([]);
    expect(left).toMatch(/^ℹ Left open: the judge of 2 sessions in run (\S+): Run \1 waits for a confined tool: .+\. A driver whose tools judge them takes them with: teamai workflow next \1 --json '\{"driver":\{…,"can":\{…\}\}\}'$/u);
    expect(drained.lines).not.toContain('✔ Nothing left to do here');
    const runId = /in run (\S+):/u.exec(left ?? '')?.[1];

    const again = await drain();

    expect(again.lines).toContain(`ℹ Left open: run ${runId} of teamai-finished-sessions is already working here. Run teamai score --drain again once it ends.`);
  });

  /** A team whose teamai.yaml sets `workflows.driver: <driver>`, and whose teamai-finished-sessions has one command step, with an unattended session captured. */
  async function finishedSessionsFor(driver: string): Promise<LocalConfig> {
    const { config } = await team({
      'teamai.yaml': `team: acme\nrepo: https://example.com/acme/team.git\nworkflows: { driver: ${driver} }\n`,
      'workflows/teamai-finished-sessions.yaml': `schemaVersion: v1alpha1
name: teamai-finished-sessions
description: Stands in for the shipped one.
invoke: deny
private: true
inputs:
  publish: policy | always | never
  scorers: [string]
steps:
  - id: mark
    command: echo marked
`,
    });
    await syncScorersThenWorkflows(config);
    capturedSession(SESSION, 'unattended');
    vi.stubEnv('CI', 'true');
    return config;
  }

  it('starts its run awaiting the driver workflows.driver names, drives none of it here, and says how to drive it here', async () => {
    const config = await finishedSessionsFor('acme-sandbox');

    const drained = await drain();

    const [ran, ...others] = (await readRuns(config)).filter((one) => one.name === 'teamai-finished-sessions');
    expect(others).toEqual([]);
    expect(ran).toMatchObject({ status: 'running', awaits: { driver: 'acme-sandbox' }, steps: [{ id: 'mark', status: 'pending' }] });
    if (!ran) throw new Error('no teamai-finished-sessions run');
    expect(projectRun(ran, {})).toMatchObject({ ok: true, value: { awaits: { driver: 'acme-sandbox' } } });
    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain(`ℹ ${ran?.id} waits for driver acme-sandbox, which this machine does not run. To drive it here: teamai workflow resume ${ran?.id} --driver local`);
    expect(drained.lines).not.toContain('✔ Nothing left to do here');
  });

  it('says again, on the next drain, which driver its open run awaits, not that it works here', async () => {
    const config = await finishedSessionsFor('acme-sandbox');
    await drain();
    capturedSession('second-session', 'unattended');

    const again = await drain();

    const ran = (await readRuns(config)).filter((one) => one.name === 'teamai-finished-sessions');
    expect(ran).toHaveLength(1);
    expect(again.lines).toContain(`ℹ ${ran[0]?.id} waits for driver acme-sandbox, which this machine does not run. To drive it here: teamai workflow resume ${ran[0]?.id} --driver local`);
    expect(again.lines.join('\n')).not.toContain('is already working here');
  });

  it('says again, on the next drain, that its open run is left to any driver while no driver has taken it', async () => {
    const config = await finishedSessionsFor('none');
    await drain();
    capturedSession('second-session', 'unattended');

    const again = await drain();

    const ran = (await readRuns(config)).filter((one) => one.name === 'teamai-finished-sessions');
    expect(ran).toHaveLength(1);
    expect(again.lines).toContain(`ℹ Left open: run ${ran[0]?.id} of teamai-finished-sessions, which workflows.driver none leaves to any driver. A driver takes it with: teamai workflow next ${ran[0]?.id} --json '{"driver":{…}}'`);
    expect(again.lines.join('\n')).not.toContain('is already working here');
  });

  it('no longer awaits a driver once a driver takes a lease of the run', async () => {
    const config = await finishedSessionsFor('acme-sandbox');
    await drain();
    const ran = (await readRuns(config)).find((one) => one.name === 'teamai-finished-sessions');
    if (!ran) throw new Error('no teamai-finished-sessions run');

    const asked = data(await leaseNext(config, ran.id, { kind: 'local', machine: 'm1', workspace: root }, { canTakeLease: false }));
    expect(asked).toHaveProperty('wait');
    expect(await readRun(config, ran.id)).toMatchObject({ awaits: { driver: 'acme-sandbox' } });

    expect(data(await leaseNext(config, ran.id, { kind: 'local', machine: 'm1', workspace: root }))).toHaveProperty('lease');
    expect(await readRun(config, ran.id)).not.toHaveProperty('awaits');
  });

  it('starts its run for any driver with workflows.driver none, awaiting none, and says which run it left', async () => {
    const config = await finishedSessionsFor('none');

    const drained = await drain();

    const ran = (await readRuns(config)).find((one) => one.name === 'teamai-finished-sessions');
    expect(ran).toMatchObject({ status: 'running', steps: [{ id: 'mark', status: 'pending' }] });
    expect(ran?.awaits).toBeUndefined();
    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain(`ℹ Left open: run ${ran?.id} of teamai-finished-sessions, which workflows.driver none leaves to any driver. A driver takes it with: teamai workflow next ${ran?.id} --json '{"driver":{…}}'`);
  });

  it.each<[string, ScoreOptions]>([
    ['--push', { push: true }],
    ['--scorer', { scorer: ['quality'] }],
  ])('refuses --drain with %s', async (_, options) => {
    await team();
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    process.exitCode = 0;
    try {
      await scoreCommand({ drain: true, ...options });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
    }
    expect(JSON.parse(written.join(''))).toEqual({ error: { code: 'invalid_arguments', message: '--drain goes alone: teamai score --drain' } });
  });

  it('runs at the end of an unattended local run, which keeps the run\'s outcome as its exit code when a publish fails', async () => {
    const { origin, config } = await team({ 'workflows/mark.yaml': MARK });
    await syncScorersThenWorkflows(config);
    await LabelStore.append(config, [{ label: {
      scorer: 'quality', rubric: { sourceHash: 'h1' }, label: 'good', score: 1, passed: true,
      source: 'session', subject: { platform: 'claude-code', sessionId: SESSION }, judge: { kind: 'human' }, scoredAt: new Date().toISOString(),
    }, reasoning: 'Did the work.' }]);
    fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "push refused" >&2\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('CI', 'true');

    const started = await driveLocally(() => workflowStart('mark', { driver: 'local' }));

    expect(started.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(started.code, started.lines.join('\n')).toBe(0);
    const draining = started.lines.indexOf('ℹ Draining before exit (teamai score --drain)');
    expect(draining, started.lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(started.lines.slice(draining)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^✖ Could not publish 1 workflow run record and 1 label to teamai-reports: /),
    ]));
  });

  it('does not run at the end of an unattended local run with unattended: off in teamai.yaml and scoring.yaml', async () => {
    const { origin, config } = await team({
      'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { unattended: off }\n',
      'scorers/scoring.yaml': 'sessions: { unattended: off }\n',
      'workflows/mark.yaml': MARK,
    });
    await syncScorersThenWorkflows(config);
    capturedSession(SESSION, 'unattended');
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const started = await driveLocally(() => workflowStart('mark', { driver: 'local' }));

    expect(started.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(started.lines).not.toContain('ℹ Draining before exit (teamai score --drain)');
    expect(await LabelStore.local(config)).toEqual([]);
    expect(onReports(origin, 'sessions')).toEqual([]);
  });

  it('does not run at the end of an unattended local run of teamai-finished-sessions, which a drain drives itself', async () => {
    const { config } = await team({ 'workflows/teamai-finished-sessions.yaml': `schemaVersion: v1alpha1
name: teamai-finished-sessions
description: Stands in for the shipped one.
invoke: deny
private: true
inputs:
  publish: policy | always | never
  scorers: [string]
steps:
  - id: sessions
    command: echo listed
` });
    await syncScorersThenWorkflows(config);
    vi.stubEnv('CI', 'true');

    const started = await driveLocally(() => workflowStart('teamai-finished-sessions', { driver: 'local', inputs: '{"publish":"policy","scorers":[]}' }));

    expect(started.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(started.lines).not.toContain('ℹ Draining before exit (teamai score --drain)');
  });

  it('does not run at the end of a command\'s run inside a workflow step, even of a workflow that is not private', async () => {
    const { config } = await team({ 'workflows/mark.yaml': MARK });
    await syncScorersThenWorkflows(config);
    vi.stubEnv('CI', 'true');
    const shortcut = async (): Promise<void> => { await runShortcut({ workflow: 'mark', inputs: {}, command: 'teamai mark', json: true }); };

    const outside = await driveLocally(shortcut);
    vi.stubEnv(ATTEMPT_ENV, 'r0123456789abcdef/a0123456789');
    const inside = await driveLocally(shortcut);

    expect(outside.lines).toContain('ℹ Draining before exit (teamai score --drain)');
    expect(inside.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(inside.lines).not.toContain('ℹ Draining before exit (teamai score --drain)');
  });

  it('does not run at the end of an attended local run', async () => {
    const { config } = await team({ 'workflows/mark.yaml': MARK });
    await syncScorersThenWorkflows(config);

    const started = await driveLocally(() => workflowStart('mark', { driver: 'local' }));

    expect(started.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(started.lines).not.toContain('ℹ Draining before exit (teamai score --drain)');
  });

  it('runs at the end of an unattended local resume', async () => {
    const { config } = await team({ 'workflows/mark.yaml': MARK });
    await syncScorersThenWorkflows(config);
    const checkout = path.join(root, 'app');
    fs.mkdirSync(checkout, { recursive: true });
    const runId = String(data(await startRun(config, 'mark', {}, { secrets: {}, runMode: 'unattended', checkout })).run);
    vi.stubEnv('CI', 'true');

    const resumed = await driveLocally(() => workflowResume(runId, {}));

    expect(resumed.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const draining = resumed.lines.indexOf('ℹ Draining before exit (teamai score --drain)');
    expect(draining, resumed.lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(resumed.lines.slice(draining)).toContain('✔ Nothing left to do here');
  });

});

/** Runs `teamai score` with `options` from `<root>/app` and returns the envelope it printed and its exit code. */
async function scored(options: ScoreOptions): Promise<{ envelope: unknown; code: number }> {
  const work = path.join(root, 'app');
  fs.mkdirSync(work, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(work);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  process.exitCode = 0;
  try {
    await scoreCommand(options);
    return { envelope: JSON.parse(out), code: Number(process.exitCode ?? 0) };
  } finally {
    vi.mocked(process.stdout.write).mockRestore();
    process.exitCode = 0;
  }
}

describe('teamai score of a subject the person names', () => {
  it.each<[string, ScoreOptions, string, string]>([
    ['a run with no scorer', { run: 'r1' }, 'invalid_arguments', 'Pass --run <id> --scorer <name> to judge a pass on demand; --step <path> picks the step when the run lists the scorer on several, --pass <n> a pass, else the latest that succeeded'],
    ['a step with no run', { step: 'review', scorer: ['quality'] }, 'invalid_arguments', 'Pass --run <id> --scorer <name> to judge a pass on demand; --step <path> picks the step when the run lists the scorer on several, --pass <n> a pass, else the latest that succeeded'],
    ['pass 0', { run: 'r1', scorer: ['quality'], pass: '0' }, 'invalid_pass', 'Pass --pass as a positive integer: the pass of the step to judge'],
    ['pass 1.5', { run: 'r1', scorer: ['quality'], pass: '1.5' }, 'invalid_pass', 'Pass --pass as a positive integer: the pass of the step to judge'],
    ['a pass past the safe integers', { run: 'r1', scorer: ['quality'], pass: '9007199254740993' }, 'invalid_pass', 'Pass --pass as a positive integer: the pass of the step to judge'],
    ['a session with no scorer', { session: SESSION }, 'invalid_arguments', 'Pass --scorer <name> to judge a session: teamai score [--session <id>] [--source <platform>] --scorer <name> [--batch]'],
    ['a label with no scorer', { label: 'good' }, 'invalid_arguments', 'Pass --scorer <name> with --label: the scorer the value is a label of.'],
    ['a pushed session and a session here', { teamSession: 'retries', session: SESSION, scorer: ['quality'] }, 'invalid_arguments', '--team-session names a pushed session, and --session and --source one on this machine. Pass one of them.'],
    ['a pushed session and a source', { teamSession: 'retries', source: 'claude-code', scorer: ['quality'] }, 'invalid_arguments', '--team-session names a pushed session, and --session and --source one on this machine. Pass one of them.'],
    ['an author with no pushed session', { author: 'alice', scorer: ['quality'] }, 'invalid_arguments', '--author picks who pushed --team-session <name>. Pass it with --team-session.'],
    ['--batch with no scorer, which asks for a session', { batch: true }, 'invalid_arguments', 'Pass --scorer <name> to judge a session: teamai score [--session <id>] [--source <platform>] --scorer <name> [--batch]'],
    ['a run and a session at once', { run: 'r1', session: SESSION, scorer: ['quality'] }, 'invalid_arguments', 'Pass --run to judge a workflow pass, or --session, --team-session or --label to score a session, not both'],
    ['a hand label of a pass, naming the command that labels it', { run: 'r1', step: 'review', pass: '2', scorer: ['quality'], label: 'bad' }, 'invalid_arguments',
      '--label labels a session. To label pass 2 of step review of run r1 by hand, run in your own terminal: teamai workflow start teamai-score --driver local --inputs \'{"subject":"run:r1:review:2","scorers":["quality"],"label":"bad","batch":false,"demand":"named"}\''],
    ['a hand label of a pass it does not name in full', { run: 'r1', label: 'bad' }, 'invalid_arguments',
      '--label labels a session. To label pass <pass> of step <step path> of run r1 by hand, run in your own terminal: teamai workflow start teamai-score --driver local --inputs \'{"subject":"run:r1:<step path>:<pass>","scorers":["<scorer>"],"label":"bad","batch":false,"demand":"named"}\''],
    ['--push with a scorer file', { push: true, scorer: ['./draft.md'] }, 'invalid_arguments', '--push publishes stored labels, and the label of the scorer file ./draft.md is never stored. Leave out --push to try the file'],
    ['no subject', {}, 'invalid_arguments', 'Pass --run <id> --scorer <name> [--step <path>] to judge a pass on demand, --scorer <name> [--session <id>] to judge a session, or --push to publish pending labels'],
    ['--driver with no subject', { driver: 'none' }, 'invalid_arguments', '--driver picks who drives the teamai-score run that --run, --session or --team-session starts. Pass one of them.'],
  ])('refuses %s, and says what to pass', async (_case, options, code, message) => {
    expect(await scored(options)).toEqual({ envelope: { error: { code, message } }, code: 1 });
  });

  it('starts teamai-try-scorer for a scorer file, on the driver --driver names', async () => {
    const { config } = await team();
    claudeSession(SESSION, 'Added the retries.');
    fakeClaude();
    fs.writeFileSync(path.join(root, 'app', 'draft.md'), SCORER);

    const started = await scored({ session: SESSION, source: 'claude-code', scorer: ['./draft.md'], driver: 'none' });
    const runId = z.object({ data: z.object({ run: z.string() }) }).parse(started.envelope).data.run;
    expect(await readRun(config, runId)).toMatchObject({
      status: 'running', definition: { name: 'teamai-try-scorer' },
      inputs: { subject: `session:claude-code:${SESSION}`, files: [path.join(root, 'app', 'draft.md')], batch: false },
    });
    expect(await LabelStore.local(config)).toEqual([]);
  });

  it('names, in an agent session, the teamai score of a scorer file the person runs, and /teamai-new-scorer for the agent', async () => {
    await team();
    claudeSession(SESSION, 'Added the retries.');
    fakeClaude();
    fs.writeFileSync(path.join(root, 'app', 'draft.md'), SCORER);
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'agent-session');

    expect(await scored({ session: SESSION, source: 'claude-code', scorer: ['./draft.md'] })).toEqual({ envelope: { error: {
      code: 'invoke_denied',
      message: expect.stringMatching(new RegExp(`\\. The person runs teamai score --session ${SESSION} --source claude-code --scorer \\./draft\\.md in their own terminal, and the agent drafts and tries a scorer with /teamai-new-scorer\\.$`, 'u')),
    } }, code: 1 });
  });

  it('refuses --label for a scorer file, whose label is never stored', async () => {
    await team();

    expect(await scored({ scorer: ['./draft.md'], label: 'good' })).toEqual({ envelope: { error: {
      code: 'invalid_arguments', message: '--label is stored, and the label of the scorer file ./draft.md is never stored. Pass the name of a scorer teamai pull cached.',
    } }, code: 1 });
  });

  it.each(['quality', 'teamai:routing:review'])('refuses scorer %s beside a scorer file, so the file is only tried and no label is stored', async (named) => {
    const { config } = await team();

    expect(await scored({ scorer: ['./draft.md', named], batch: true })).toEqual({ envelope: { error: {
      code: 'invalid_arguments', message: `A scorer file is tried by a teamai-try-scorer run, which stores nothing, and --scorer ${named} is judged by a teamai-score run. Score them in separate commands.`,
    } }, code: 1 });
    expect(await LabelStore.local(config)).toEqual([]);
  });

  it('publishes with --push alone, with nothing pending', async () => {
    await team();

    expect(await scored({ push: true })).toEqual({ envelope: { data: { published: true } }, code: 0 });
  });

  it('keeps a label pending with --push while origin is unreachable, and says so once', async () => {
    const { origin, config } = await team();
    await LabelStore.append(config, [{ label: {
      scorer: 'quality', rubric: { sourceHash: 'h1' }, label: 'good', score: 1, passed: true, source: 'session',
      subject: { platform: 'claude-code', sessionId: SESSION }, judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read' }, scoredAt: '2026-10-20T12:00:00.000Z',
    }, reasoning: 'Did the work.' }]);
    fs.renameSync(origin, `${origin}.away`);
    const said = vi.spyOn(log, 'warn');

    expect(await scored({ push: true })).toEqual({ envelope: { data: { published: false } }, code: 0 });
    expect(said.mock.calls.flat().join('\n')).not.toContain('What workflow steps published to teamai-reports stays pending');
  });

  it('starts the run awaiting the driver workflows.driver names, which this machine does not run, and says how to drive it here', async () => {
    const { config } = await team({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nworkflows: { driver: acme-sandbox }\n' });
    await syncScorersThenWorkflows(config);
    claudeSession(SESSION, 'Added the retries.');

    const started = await scored({ session: SESSION, source: 'claude-code', scorer: ['quality'] });

    expect(started).toMatchObject({ envelope: { data: { name: 'teamai-score', status: 'running' } }, code: 0 });
    const runId = z.object({ data: z.object({ run: z.string() }) }).parse(started.envelope).data.run;
    expect(vi.mocked(console.error).mock.calls.map((call) => call.map(String).join(' '))).toContain(
      `ℹ ${runId} waits for driver acme-sandbox, which this machine does not run. To drive it here: teamai workflow resume ${runId} --driver local`,
    );
    expect(await readRun(config, runId)).toMatchObject({ awaits: { driver: 'acme-sandbox' }, steps: expect.arrayContaining([expect.objectContaining({ id: 'plan', status: 'pending' })]) });
  });

  it('says the run workflows.driver none leaves open is left to any driver, and how one takes it', async () => {
    const { config } = await team({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nworkflows: { driver: none }\n' });
    await syncScorersThenWorkflows(config);
    claudeSession(SESSION, 'Added the retries.');

    const started = await scored({ session: SESSION, source: 'claude-code', scorer: ['quality'] });

    const runId = z.object({ data: z.object({ run: z.string() }) }).parse(started.envelope).data.run;
    expect(vi.mocked(console.error).mock.calls.map((call) => call.map(String).join(' '))).toContain(
      `ℹ Left open: run ${runId} of teamai-score, which workflows.driver none leaves to any driver. A driver takes it with: teamai workflow next ${runId} --json '{"driver":{…}}'`,
    );
    expect(await readRun(config, runId)).not.toHaveProperty('awaits');
  });

  it('leaves workflow start without --driver unassigned, whatever workflows.driver names', async () => {
    const { config } = await team({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nworkflows: { driver: acme-sandbox }\n', 'workflows/mark.yaml': MARK });
    await syncScorersThenWorkflows(config);

    const started = await driveLocally(() => workflowStart('mark', {}));

    const runId = z.object({ data: z.object({ run: z.string() }) }).parse(started.envelope).data.run;
    expect(await readRun(config, runId)).toMatchObject({ status: 'running', steps: [{ id: 'mark', status: 'pending' }] });
    expect(await readRun(config, runId)).not.toHaveProperty('awaits');
    expect(started.lines.join('\n')).not.toContain('waits for driver');
  });

  it('names, in an agent session, the teamai score of a session the person runs and what the agent runs', async () => {
    await team();
    claudeSession(SESSION, 'Added the retries.');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'agent-session');

    expect(await scored({ session: SESSION, source: 'claude-code', scorer: ['quality'], label: 'good', driver: 'none' })).toEqual({ envelope: { error: {
      code: 'invoke_denied',
      message: expect.stringMatching(new RegExp(`\\. The person runs teamai score --session ${SESSION} --source claude-code --scorer quality --label good --driver none in their own terminal, and the agent judges this session with /teamai-share-session\\.$`, 'u')),
    } }, code: 1 });
  });

  it('names, in an agent session, the teamai score of a pass the person runs, with the pass in full', async () => {
    const { config } = await team({ 'workflows/review.yaml': WORKFLOW });
    claudeSession(STEP_SESSION, 'Reviewed it.');
    const runId = await settledRun(config, 'attended', { tool: 'claude', session: STEP_SESSION });
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'agent-session');

    expect(await scored({ run: runId, scorer: ['quality'], batch: true, push: true })).toEqual({ envelope: { error: {
      code: 'invoke_denied',
      message: expect.stringMatching(new RegExp(`\\. The person runs teamai score --run ${runId} --step review --pass 1 --scorer quality --batch --push in their own terminal\\.$`, 'u')),
    } }, code: 1 });
  });
});

describe('the drain at the end of an unattended run', () => {
  it('warns why it judges no session while the scoring settings do not load', async () => {
    const { config } = await team({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { unattended: off }\n', 'scorers/scoring.yaml': 'sessions: [unclosed\n' });
    const warn = vi.spyOn(log, 'warn');

    expect(await Drain.drainsUnattendedRun(config)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[user\] Finished sessions are not judged here: .*scorers\/scoring\.yaml/));
  });
});
