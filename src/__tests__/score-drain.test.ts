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

import type { RunMode } from '../launch-context.js';
import { saveLocalConfig } from '../config.js';
import { dataHomeKey } from '../dashboard-collector.js';
import { driverIdentity } from '../driver-identity.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { LabelStore } from '../scorers/label-store.js';
import { scoreCommand, type ScoreOptions } from '../score-commands.js';
import { Drain } from '../score-drain.js';
import { judgePassLock, scoreSessionsCommand } from '../score-sessions.js';
import YAML from 'yaml';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { SessionWork } from '../session-flow/session-work.js';
import { getReportsDir, REPORTS_LOCK_FILENAME, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, parseReport, reportAttempt, startRun } from '../workflow/engine.js';
import { nextJudgeLease, submitJudgeLease } from '../workflow/scoring.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { workflowResume, workflowStart } from '../workflow-commands.js';

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
  await syncWorkflowDefinitions(config);
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

  it('in an unattended job with no settings, judges each session captured unattended with every scorer that judges sessions', async () => {
    const { config } = await team();
    capturedSession(SESSION, 'unattended', { idleFor: 0 });
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('✔ Judged 1 sampled session here (quality)');
    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'quality', source: 'session', subject: { platform: 'claude-code', sessionId: SESSION }, runMode: 'unattended' }]);
  });

  it('leaves a session whose scorer pins a model no judge tool here runs to another driver, says so, and exits 0', async () => {
    const { config } = await team({
      'scorers/quality.md': SCORER.replace('sessions: true\n', 'sessions: true\nmodel: strong\n'),
      'models/aliases.yaml': 'aliases:\n  strong:\n    codex: gpt-6\n',
    });
    capturedSession(SESSION, 'unattended');
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('ℹ Left open: 1 session whose scorer pins a model no judge tool here runs (judge_model_unavailable). '
      + 'A driver whose tools run it takes it with: teamai score --next --json \'{"driver":{…,"can":{"judge":{…}}}}\'');
    expect(drained.lines).not.toContain('✔ Nothing left to do here');
    const other = { driver: { kind: 't3', machine: 'm2', workspace: '/w' }, judge: { isolation: 'best-effort' as const, tools: ['codex'] as [string] }, running: [] };
    expect(await nextJudgeLease(config, other)).toMatchObject({ data: { lease: { source: 'session', subject: { sessionId: SESSION } } } });
  });

  it('leaves a session whose isolation no judge tool here reaches to another driver, says so, and exits 0', async () => {
    await team({ 'scorers/scoring.yaml': 'isolation: verified\n' });
    capturedSession(SESSION, 'unattended');
    fakeClaude({ version: '2.0.0 (Claude Code)' });
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('ℹ Left open: 1 entry that needs an isolation no judge tool here reaches. '
      + 'A driver whose judge reaches it takes it with: teamai score --next --json \'{"driver":{…,"can":{"judge":{…}}}}\'');
    expect(drained.lines).not.toContain('✔ Nothing left to do here');
  });

  it('leaves the judge entries to another driver when no judge tool is installed here, says so, and exits 0', async () => {
    const { config } = await team();
    capturedSession(SESSION, 'unattended');
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('ℹ Left open: 1 judge entry: no judge tool is installed here. '
      + 'A driver whose tools judge it takes it with: teamai score --next --json \'{"driver":{…,"can":{"judge":{…}}}}\'');
    expect(drained.lines).not.toContain('✔ Nothing left to do here');
    const other = { driver: { kind: 't3', machine: 'm2', workspace: '/w' }, judge: { isolation: 'best-effort' as const, tools: ['claude'] as [string] }, running: [] };
    expect(await nextJudgeLease(config, other)).toMatchObject({ data: { lease: { source: 'session', subject: { sessionId: SESSION } } } });
  });

  it('leaves the session lease the background pass holds live when no judge tool is installed here', async () => {
    const { config } = await team({ 'scorers/scoring.yaml': 'sessions: true\n' });
    capturedSession(SESSION, 'attended');
    capturedSession(STEP_SESSION, 'attended');
    const driver = driverIdentity('local', SessionWork.leaseCwd(config));
    const taken = data(await nextJudgeLease(config, { driver, judge: { isolation: 'best-effort', tools: ['claude'] }, running: [], only: 'session' }));
    const { ref } = taken.lease as { ref: string };

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('ℹ Left open: 1 judge entry: no judge tool is installed here. '
      + 'A driver whose tools judge it takes it with: teamai score --next --json \'{"driver":{…,"can":{"judge":{…}}}}\'');
    expect(data(await submitJudgeLease(config, ref, { driver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }))).toMatchObject({ label: { label: 'good' } });
  });

  it('judges nothing while the background pass judges, leaves its session lease live, and says what it left open', async () => {
    const { config } = await team({ 'scorers/scoring.yaml': 'sessions: true\n' });
    capturedSession(SESSION, 'attended');
    capturedSession(STEP_SESSION, 'attended');
    const driver = driverIdentity('local', SessionWork.leaseCwd(config));
    const lock = judgePassLock(config);
    expect(await acquireLock(lock)).toBe(true);
    let drained: Awaited<ReturnType<typeof drain>>;
    try {
      // The pass offered a tool this drain does not: it holds a lease with codex.
      const taken = data(await nextJudgeLease(config, { driver, judge: { isolation: 'best-effort', tools: ['codex'] }, running: [], only: 'session' }));
      fakeClaude();
      drained = await drain();
      const { ref } = taken.lease as { ref: string };
      expect(data(await submitJudgeLease(config, ref, { driver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }))).toMatchObject({ label: { label: 'good' } });
    } finally {
      await releaseLock(lock);
    }

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('ℹ Left open: 1 judge entry: another judge pass on this machine is running. Run teamai score --drain again once it ends.');
    expect(drained.lines.filter((printed) => printed.includes('Judged'))).toEqual([]);
    expect(drained.lines).not.toContain('✔ Nothing left to do here');
  });

  it('says once what it ignores in the scoring settings, however many leases it takes', async () => {
    await team({ 'scorers/scoring.yaml': 'daily_limit: -1\n' });
    capturedSession(SESSION, 'unattended');
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.lines.filter((printed) => printed.includes('daily_limit is -1')), drained.lines.join('\n')).toEqual([
      '⚠ scorers/scoring.yaml: daily_limit is -1, not a whole number of 0 or more, so it is ignored.',
    ]);
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
    expect(fs.existsSync(judgePassLock(legacy))).toBe(false);
    expect(fs.existsSync(path.dirname(judgePassLock(legacy)))).toBe(false);
  });

  it('prints a failed judgment and exits 1, and a second drain exits 0 without judging it again', async () => {
    await team();
    capturedSession(SESSION, 'unattended');
    fakeClaude({ fails: true });
    vi.stubEnv('CI', 'true');

    const failed = await drain();

    expect(failed.code, failed.lines.join('\n')).toBe(1);
    expect(failed.lines).toContain(`✖ quality on claude-code session ${SESSION}: judge_failed. A failed judgment is final and is not retried. `
      + `To ask for a new one: teamai score --session ${SESSION} --source claude-code --scorer quality`);

    fakeClaude();
    const again = await drain();

    expect(again.code, again.lines.join('\n')).toBe(0);
    expect(again.lines.filter((printed) => printed.includes('Judged'))).toEqual([]);
    expect(again.lines).toContain('✔ Nothing left to do here');
  });

  it('prints a failed judgment of a pass and exits 1, and a second drain exits 0 without judging it again', async () => {
    const { config } = await team({ 'workflows/review.yaml': WORKFLOW });
    const runId = await settledRun(config, 'unattended');
    fakeClaude({ fails: true });
    vi.stubEnv('CI', 'true');

    const failed = await drain();

    expect(failed.code, failed.lines.join('\n')).toBe(1);
    expect(failed.lines).toContain(`✖ quality on pass 1 of step review in run ${runId}: judge_failed. A failed judgment is final and is not retried. `
      + `To ask for a new one: teamai score --run ${runId} --step review --pass 1 --scorer quality`);

    fakeClaude();
    const again = await drain();

    expect(again.code, again.lines.join('\n')).toBe(0);
    expect(again.lines.filter((printed) => printed.includes('Judged'))).toEqual([]);
  });

  it('publishes the labels it judged to teamai-reports', async () => {
    const { origin } = await team();
    capturedSession(SESSION, 'unattended');
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('✔ Published 1 label to teamai-reports');
    expect(onReports(origin, 'scores')).toEqual([expect.stringMatching(/^scores\/tester\/\d{4}-\d{2}\.jsonl$/)]);
  });

  it('exits 1 when it cannot publish, and the next drain publishes what stayed pending', async () => {
    const { origin } = await team();
    capturedSession(SESSION, 'unattended');
    fakeClaude();
    vi.stubEnv('CI', 'true');
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "push refused" >&2\nexit 1\n', { mode: 0o755 });

    const failed = await drain();

    expect(failed.code, failed.lines.join('\n')).toBe(1);
    expect(failed.lines.filter((printed) => printed.startsWith('✖'))).toEqual([
      expect.stringMatching(/^✖ Could not publish 1 label and 1 session to teamai-reports: [\s\S]*push refused[\s\S]*\. They stay pending; run teamai score --drain again\.$/),
    ]);
    expect(failed.lines.join('\n').split('push refused')).toHaveLength(2);
    expect(onReports(origin, '')).toEqual([]);

    fs.rmSync(hook);
    const again = await drain();

    expect(again.code, again.lines.join('\n')).toBe(0);
    expect(again.lines).toEqual(expect.arrayContaining(['✔ Published 1 label to teamai-reports', '✔ Archived 1 captured session to teamai-reports (scrubbed)']));
    expect(onReports(origin, 'scores')).toHaveLength(1);
    expect(onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'))).toHaveLength(1);
  });

  it('says the cause ssh gives when it cannot publish, in one sentence', async () => {
    const { config } = await team();
    capturedSession(SESSION, 'unattended');
    fakeClaude();
    vi.stubEnv('CI', 'true');
    const ssh = path.join(root, 'bin', 'ssh-denied');
    fs.writeFileSync(ssh, '#!/bin/sh\necho "git@example.invalid: Permission denied (publickey)." >&2\nexit 255\n', { mode: 0o755 });
    vi.stubEnv('GIT_SSH_COMMAND', ssh);
    execFileSync('git', ['-C', config.repo.localPath, 'config', 'remote.origin.pushurl', 'git@example.invalid:acme/team.git']);

    const failed = await drain();

    expect(failed.code, failed.lines.join('\n')).toBe(1);
    expect(failed.lines.filter((printed) => printed.startsWith('✖ Could not publish'))).toEqual([
      '✖ Could not publish 1 label and 1 session to teamai-reports: git@example.invalid: Permission denied (publickey).; fatal: Could not read from remote repository.; '
        + 'Please make sure you have the correct access rights; and the repository exists. They stay pending; run teamai score --drain again.',
    ]);
  });

  it('says once that another process is writing teamai-reports, for labels and sessions alike', async () => {
    const { config } = await team();
    capturedSession(SESSION, 'unattended');
    fakeClaude();
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
    expect(drained.lines, drained.lines.join('\n')).toContain('✖ Could not publish 1 label and 1 session to teamai-reports: another teamai process is writing teamai-reports. They stay pending; run teamai score --drain again.');
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

  it('archives each session captured unattended once, scrubbed, on teamai-reports', async () => {
    const { origin } = await team();
    capturedSession(SESSION, 'unattended', { answer: `Added the retries. The deploy token is ${TOKEN}.` });
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('✔ Archived 1 captured session to teamai-reports (scrubbed)');
    const [archived, ...more] = onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'));
    expect(more).toEqual([]);
    expect(readOnReports(origin, archived)).toContain('Added the retries.');
    expect(readOnReports(origin, archived)).not.toContain(TOKEN);

    const again = await drain();

    expect(again.code, again.lines.join('\n')).toBe(0);
    expect(again.lines.filter((printed) => /Judged|Published|Archived/.test(printed))).toEqual([]);
    expect(again.lines).toContain('✔ Nothing left to do here');
  });

  it('masks the value of a secret the team declares, whatever its name, in the sessions it archives', async () => {
    const dsn = 'mysql-prod-7Hq2xVb9Lk';
    const { origin, config } = await team({ 'env/secrets.yaml': 'secrets:\n  - key: WAREHOUSE_DSN\n', 'workflows/review.yaml': WORKFLOW.replace('    scorers: [quality]\n', '') });
    vi.stubEnv('WAREHOUSE_DSN', dsn);
    capturedSession(SESSION, 'unattended', { answer: `Added the retries against ${dsn}.` });
    claudeSession(STEP_SESSION, `Reviewed it against ${dsn}.`);
    await settledRun(config, 'unattended', { tool: 'claude', session: STEP_SESSION });
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    const archived = onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'));
    expect(archived).toHaveLength(2);
    const texts = archived.map((file) => readOnReports(origin, file));
    expect(texts.join('\n')).toContain('Added the retries against');
    expect(texts.join('\n')).toContain('Reviewed it against');
    for (const text of texts) expect(text).not.toContain(dsn);
  });

  it('archives the step sessions of the runs it drives in this mode once, scrubbed, and lists once a pass whose tool it reads no sessions from', async () => {
    const { origin, config } = await team({ 'workflows/review.yaml': WORKFLOW.replace('    scorers: [quality]\n', '') });
    claudeSession(STEP_SESSION, `Reviewed it. The deploy token is ${TOKEN}.`);
    const archivedRun = await settledRun(config, 'unattended', { tool: 'claude', session: STEP_SESSION });
    const skippedRun = await settledRun(config, 'unattended', { tool: 'pi', session: 'pi-1' });
    await settledRun(config, 'attended', { tool: 'claude', session: '7c1e0000-0000-4000-8000-000000000022' });
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toEqual(expect.arrayContaining([
      `✔ Archived 1 step session of ${archivedRun} to teamai-reports (scrubbed)`,
      `ℹ Skipped 1 step session of ${skippedRun}: teamai reads no sessions from pi (review, pass 1)`,
    ]));
    const [archived, ...more] = onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'));
    expect(more).toEqual([]);
    expect(readOnReports(origin, archived)).toContain('Reviewed it.');
    expect(readOnReports(origin, archived)).not.toContain(TOKEN);

    const again = await drain();

    expect(again).toEqual({ code: 0, lines: ['✔ Nothing left to do here'] });
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
      expect.stringMatching(new RegExp(`^ℹ Skipped 1 step session of ${runId}: the claude-code session ${unreadable} cannot be read here: .+ \\(check, pass 1\\)$`)),
    ]));
    expect(onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'))).toHaveLength(1);

    const again = await drain();

    expect(again).toEqual({ code: 0, lines: ['✔ Nothing left to do here'] });
  });

  it('reports the usage of an unattended session to stats/<member>.yaml under unattended, on a data home that never ran pull', async () => {
    const { origin } = await team();
    capturedSession(SESSION, 'unattended');
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
    capturedSession(SESSION, 'unattended');
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

  it('judges sampled sessions within daily_limit, with every scorer that judges sessions', async () => {
    const { config } = await team({
      'scorers/rare.md': SCORER.replace('samplingRate: 100', 'samplingRate: 0'),
      'scorers/scoring.yaml': 'daily_limit: 1\n',
    });
    capturedSession(SESSION, 'unattended');
    capturedSession('7c1e0000-0000-4000-8000-000000000012', 'unattended');
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('✔ Judged 1 sampled session here (quality)');
    expect((await LabelStore.local(config)).map((label) => label.scorer)).toEqual(['quality']);
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

  it('in attended mode with publish attended auto, archives an attended session idle six hours and leaves an active one', async () => {
    const { origin } = await team({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { attended: auto }\n' });
    capturedSession(SESSION, 'attended', { answer: 'The idle answer.' });
    capturedSession('7c1e0000-0000-4000-8000-000000000012', 'attended', { idleFor: 0, answer: 'The active answer.' });

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('✔ Archived 1 captured session to teamai-reports (scrubbed)');
    const archived = onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'));
    expect(archived.map((file) => readOnReports(origin, file))).toEqual([expect.stringContaining('The idle answer.')]);
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

  it.each<[string, ScoreOptions]>([
    ['--next', { next: true }],
    ['a payload', { json: '{}' }],
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
    expect(JSON.parse(written.join(''))).toEqual({ error: { code: 'invalid_arguments', message: '--drain goes alone and takes no payload: teamai score --drain' } });
  });

  it('runs at the end of an unattended local run, which keeps the run\'s outcome as its exit code when a publish fails', async () => {
    const { origin, config } = await team({ 'workflows/mark.yaml': MARK });
    await syncWorkflowDefinitions(config);
    capturedSession(SESSION, 'unattended');
    fakeClaude();
    fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "push refused" >&2\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('CI', 'true');

    const started = await driveLocally(() => workflowStart('mark', { driver: 'local' }));

    expect(started.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(started.code, started.lines.join('\n')).toBe(0);
    const draining = started.lines.indexOf('ℹ Draining before exit (teamai score --drain)');
    expect(draining, started.lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(started.lines.slice(draining)).toEqual(expect.arrayContaining([
      '✔ Judged 1 sampled session here (quality)',
      expect.stringMatching(/^✖ Could not publish 1 workflow run record, 1 label and 1 session to teamai-reports: /),
    ]));
  });

  it('does not run at the end of an unattended local run with unattended: off in teamai.yaml and scoring.yaml', async () => {
    const { origin, config } = await team({
      'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { unattended: off }\n',
      'scorers/scoring.yaml': 'sessions: { unattended: off }\n',
      'workflows/mark.yaml': MARK,
    });
    await syncWorkflowDefinitions(config);
    capturedSession(SESSION, 'unattended');
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const started = await driveLocally(() => workflowStart('mark', { driver: 'local' }));

    expect(started.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(started.lines).not.toContain('ℹ Draining before exit (teamai score --drain)');
    expect(await LabelStore.local(config)).toEqual([]);
    expect(onReports(origin, 'sessions')).toEqual([]);
  });

  it('does not run at the end of an attended local run', async () => {
    const { config } = await team({ 'workflows/mark.yaml': MARK });
    await syncWorkflowDefinitions(config);

    const started = await driveLocally(() => workflowStart('mark', { driver: 'local' }));

    expect(started.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(started.lines).not.toContain('ℹ Draining before exit (teamai score --drain)');
  });

  it('runs at the end of an unattended local resume', async () => {
    const { config } = await team({ 'workflows/mark.yaml': MARK });
    await syncWorkflowDefinitions(config);
    const checkout = path.join(root, 'app');
    fs.mkdirSync(checkout, { recursive: true });
    const runId = String(data(await startRun(config, 'mark', {}, { secrets: {}, runMode: 'unattended', checkout })).run);
    capturedSession(SESSION, 'unattended');
    fakeClaude();
    vi.stubEnv('CI', 'true');

    const resumed = await driveLocally(() => workflowResume(runId, {}));

    expect(resumed.envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const draining = resumed.lines.indexOf('ℹ Draining before exit (teamai score --drain)');
    expect(draining, resumed.lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(resumed.lines.slice(draining)).toContain('✔ Judged 1 sampled session here (quality)');
  });

});

describe('the background pass a session start begins (teamai score-sessions)', () => {
  it('with no settings, neither archives nor judges an attended session idle six hours', async () => {
    const { origin, config } = await team();
    capturedSession(SESSION, 'attended');
    fakeClaude();

    await scoreSessionsCommand();

    expect(await LabelStore.local(config)).toEqual([]);
    expect(onReports(origin, 'sessions')).toEqual([]);
  });

  it('archives attended sessions idle six hours when sessions.publish is auto for attended, though it scores none', async () => {
    const { origin, config } = await team({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { attended: auto }\n' });
    capturedSession(SESSION, 'attended', { answer: 'The idle answer.' });
    capturedSession('7c1e0000-0000-4000-8000-000000000012', 'attended', { idleFor: 0, answer: 'The active answer.' });
    fakeClaude();

    await scoreSessionsCommand();

    const archived = onReports(origin, 'sessions').filter((file) => file.endsWith('.jsonl'));
    expect(archived.map((file) => readOnReports(origin, file))).toEqual([expect.stringContaining('The idle answer.')]);
    expect(await LabelStore.local(config)).toEqual([]);
  });
});
