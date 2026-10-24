import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { dataHomeKey } from '../../dashboard-collector.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'dist/index.js');
const agents = { claude: '.claude', codex: '.codex', codebuddy: '.codebuddy', opencode: '.config/opencode' };
// Removed after the file: the slow-push cases run concurrently.
const sandboxes = new Set<string>();

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
}

function fixture(agent: keyof typeof agents, provider: string, team: Record<string, unknown> = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-report-timeout-'));
  sandboxes.add(sandbox);
  const home = path.join(sandbox, 'home');
  const seed = path.join(sandbox, 'seed');
  const remote = path.join(sandbox, 'remote.git');
  const clone = path.join(home, '.teamai/team-repo');
  fs.mkdirSync(seed, { recursive: true });
  fs.mkdirSync(path.join(home, agents[agent]), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Report Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Report Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', FORCE_COLOR: '0' };
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: 'report-test', repo: remote, provider, ...team }));
  // The 'review' skill the fixture records usage for must be in the team's
  // shared catalog: #1055 filters published stats to catalog names.
  fs.mkdirSync(path.join(seed, 'skills', 'review'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'skills', 'review', 'SKILL.md'), '# review\n');
  git(['init', '-q', '-b', 'main'], seed, env);
  git(['add', '.'], seed, env);
  git(['commit', '-q', '-m', 'fixture'], seed, env);
  git(['clone', '-q', '--bare', seed, remote], sandbox, env);
  git(['clone', '-q', remote, clone], sandbox, env);
  fs.writeFileSync(path.join(home, '.teamai/config.yaml'), YAML.stringify({
    repo: { localPath: clone, remote, kind: 'git' }, username: 'alice', scope: 'user',
    updatePolicy: 'skip', enabledAgents: [agent], additionalRoles: [],
  }));
  const usage = path.join(home, '.teamai/user-usage.jsonl');
  const dashboard = path.join(home, '.teamai/dashboard');
  const timestamp = new Date().toISOString();
  const usageLine = JSON.stringify({ skill: 'review', tool: agent, timestamp }) + '\n';
  // A session the user scope recorded (#785).
  async function seedEvents() {
    const key = await dataHomeKey(path.join(home, '.teamai'));
    fs.mkdirSync(dashboard, { recursive: true });
    fs.writeFileSync(usage, usageLine);
    fs.writeFileSync(path.join(dashboard, 'events.jsonl'), [
      { type: 'session_start', timestamp, sessionId: 's1', tool: agent, cwd: sandbox, dataHomeKey: key },
      { type: 'prompt_submit', timestamp, sessionId: 's1', tool: agent, promptSummary: 'review', dataHomeKey: key },
      { type: 'stop', timestamp, sessionId: 's1', tool: agent, interventions: { interrupt: 1, toolReject: 0 },
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }, dataHomeKey: key },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  function receiver(mode: 'slow' | 'reject' | 'normal' | 'slow-reject') {
    // Only the first rejection must outlast pull's wait; later report writes can reject immediately.
    const delay = mode === 'slow-reject'
      ? 'if [ ! -f hooks/rejection-delayed ]; then : > hooks/rejection-delayed; sleep 7; fi'
      : 'sleep 7';
    const action = `${mode.startsWith('slow') ? `${delay}\n` : ''}${mode.endsWith('reject') ? 'exit 1' : ':'}`;
    fs.writeFileSync(path.join(remote, 'hooks/update'), `#!/bin/sh\nif [ "$1" = "refs/heads/teamai-reports" ]; then\n  ${action}\nfi\nexit 0\n`, { mode: 0o755 });
  }
  async function pull(onPending?: () => void) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--verbose', 'pull'], {
        cwd: sandbox, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let pendingObserved = false;
      let failure: unknown;
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI did not exit\n${output}`)); }, 45_000);
      function capture(data: Buffer) {
        output += data.toString();
        if (!pendingObserved && output.includes('Auto-report is still running after 5s')) {
          pendingObserved = true;
          try { onPending?.(); } catch (error) { failure = error; }
        }
      }
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`CLI exited ${code}\n${output}`));
        else resolve(output);
      });
    });
  }
  function stats() {
    return YAML.parse(git(['show', 'teamai-reports:stats/alice.yaml'], remote, env));
  }
  /** The user scope's reported snapshot (#786), `{}` before the report writes one. */
  function snapshot(name: string): Record<string, unknown> {
    const p = path.join(dashboard, `user-reported-${name}.json`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  }
  // The seeded session's snapshot key: a tool's own session ID keys its one run (#785).
  const runId = 's1';
  function run(args: string[]) {
    return execFileSync(process.execPath, [cli, ...args], { cwd: sandbox, env, encoding: 'utf8', windowsHide: true });
  }
  /** The detached background pass that a host's SessionStart hook spawns, which runs the pull. */
  function sessionStart() {
    return execFileSync(process.execPath, [cli, 'hook-dispatch', 'session-start', '--tool', agent, '--bg-only'], {
      cwd: sandbox, env, encoding: 'utf8', windowsHide: true, timeout: 45_000,
      input: JSON.stringify({ cwd: sandbox, session_id: 's2' }),
    });
  }
  return { home, env, clone, usage, usageLine, dashboard, seedEvents, receiver, pull, stats, snapshot, run, sessionStart, runId };
}

afterAll(() => {
  for (const sandbox of sandboxes) {
    if (path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('teamai-report-timeout-')) {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }
});

describe('real CLI report completion', () => {
  for (const provider of ['git', 'gitlab', 'github']) {
    for (const agent of Object.keys(agents) as Array<keyof typeof agents>) {
      // Concurrent: each case mostly waits out the remote's slow push, in its own sandbox.
      it.concurrent(`acknowledges slow pushes once: ${provider}/${agent}`, async ({ expect }) => {
        const f = fixture(agent, provider);
        await f.pull(); // Warm reports worktree without any session data.
        await f.seedEvents();
        f.receiver('slow');
        const output = await f.pull(() => {
          expect(fs.readFileSync(f.usage, 'utf8')).toBe(f.usageLine);
          expect(f.snapshot('prompt-tokens')[f.runId]).toBeUndefined();
          expect(fs.existsSync(path.join(f.home, '.teamai/.sync-lock'))).toBe(true);
          // An event arriving during the push must survive cleanup of the batch.
          fs.appendFileSync(f.usage, f.usageLine);
        });
        expect(output).toContain('Auto-report is still running after 5s');
        expect(f.stats().skills.review.count).toBe(1);
        expect(fs.readFileSync(f.usage, 'utf8')).toBe(f.usageLine);
        for (const name of ['interventions', 'prompt-tokens', 'daily-sessions']) {
          expect(f.snapshot(name)[f.runId]).toBeDefined();
        }
        expect(fs.existsSync(path.join(f.home, '.teamai/.sync-lock'))).toBe(false);
        f.receiver('normal');
        await f.pull();
        const stats = f.stats();
        expect(stats.skills.review.count).toBe(2);
        expect(stats.prompts).toBe(1);
        expect(stats.tokens.input).toBe(10);
        expect(stats.interventions.sessions).toBe(1);
        expect(fs.readFileSync(f.usage, 'utf8')).toBe('');
        await f.pull();
        expect(f.stats()).toEqual(stats);
      }, 60_000);
    }
  }

  it('retains a rejected report and retries its committed tree without counting twice', async () => {
    const f = fixture('codex', 'git');
    await f.pull();
    await f.seedEvents();
    f.receiver('reject');
    await f.pull();
    expect(fs.readFileSync(f.usage, 'utf8')).toBe(f.usageLine);
    expect(f.snapshot('prompt-tokens')[f.runId]).toBeUndefined();
    f.receiver('normal');
    await f.pull();
    const stats = f.stats();
    expect(stats.skills.review.count).toBe(1);
    expect(stats.prompts).toBe(1);
    expect(stats.tokens.input).toBe(10);
    expect(fs.readFileSync(f.usage, 'utf8')).toBe('');
  }, 60_000);

  // The dispatcher exits once its handlers settle, which must not cut the push the pull stopped waiting for (#1322).
  it('publishes a slow push started by the session-start hook before the hook process exits', async () => {
    const f = fixture('claude', 'git');
    await f.pull(); // Warm reports worktree without any session data.
    await f.seedEvents();
    f.receiver('slow');
    f.sessionStart();
    expect(f.stats().skills.review.count).toBe(1);
    expect(fs.readFileSync(f.usage, 'utf8')).toBe('');
    expect(fs.existsSync(path.join(f.home, '.teamai/.sync-lock'))).toBe(false);
  }, 60_000);

  it('keeps a rejected session-start report retryable and releases its locks', async () => {
    const f = fixture('claude', 'git');
    await f.pull();
    await f.seedEvents();
    f.receiver('slow-reject');
    f.sessionStart();
    expect(fs.readFileSync(f.usage, 'utf8')).toBe(f.usageLine);
    expect(f.snapshot('prompt-tokens')[f.runId]).toBeUndefined();
    for (const lock of ['.reports-lock', '.sync-lock']) {
      expect(fs.existsSync(path.join(f.home, '.teamai', lock)), lock).toBe(false);
    }
    f.receiver('normal');
    await f.pull();
    const stats = f.stats();
    expect(stats.skills.review.count).toBe(1);
    expect(stats.prompts).toBe(1);
    expect(stats.tokens.input).toBe(10);
    expect(fs.readFileSync(f.usage, 'utf8')).toBe('');
    expect(f.snapshot('prompt-tokens')[f.runId]).toBeDefined();
    await f.pull();
    expect(f.stats()).toEqual(stats);
  }, 60_000);

  it('does not report for a member who set usageReportEnabled: false', async () => {
    const f = fixture('claude', 'git');
    const configPath = path.join(f.home, '.teamai/config.yaml');
    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    fs.writeFileSync(configPath, YAML.stringify({ ...config, usageReportEnabled: false }));
    await f.seedEvents();
    await f.pull();
    expect(() => f.stats()).toThrow();
    expect(fs.readFileSync(f.usage, 'utf8')).toBe(f.usageLine);
    expect(f.run(['stats'])).toMatch(/review\s+1 uses/);
  }, 60_000);
});

describe('real CLI usage cap (#788)', () => {
  const cap = 5_000;
  const line = (skill: string) => JSON.stringify({ skill, tool: 'claude', timestamp: new Date().toISOString() });
  /** `legacy` oldest, `review` newest: only the newest survive a cap. */
  function seedUsage(file: string, legacy: number, review: number) {
    fs.writeFileSync(file, [...Array(legacy).fill(line('legacy')), ...Array(review).fill(line('review'))].join('\n') + '\n');
  }
  const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

  it('caps a usageReport: false scope and stats still shows its newest usage', async () => {
    const f = fixture('claude', 'git', { usageReport: false });
    seedUsage(f.usage, 100, cap);
    await f.pull();
    expect(lines(f.usage)).toEqual(Array(cap).fill(expect.stringContaining('"review"')));
    const stats = f.run(['stats']);
    expect(stats).toMatch(/review\s+5000 uses/);
    expect(stats).not.toContain('legacy');
  }, 60_000);

  it('caps an http scope and stats still shows its newest usage', async () => {
    const f = fixture('claude', 'git');
    fs.writeFileSync(path.join(f.home, '.teamai/config.yaml'), YAML.stringify({
      repo: { localPath: f.clone, remote: 'http://127.0.0.1:9/team', kind: 'http', url: 'http://127.0.0.1:9' },
      username: 'alice', scope: 'user', updatePolicy: 'skip', enabledAgents: ['claude'], additionalRoles: [],
    }));
    f.env.TEAMAI_API_TOKEN = 'unused';
    seedUsage(f.usage, 100, cap);
    await f.pull();
    expect(lines(f.usage)).toEqual(Array(cap).fill(expect.stringContaining('"review"')));
    const stats = f.run(['stats']);
    expect(stats).toMatch(/review\s+5000 uses/);
    expect(stats).not.toContain('legacy');
  }, 60_000);

  it('does not rewrite a usage file below the cap', async () => {
    const f = fixture('claude', 'git', { usageReport: false });
    seedUsage(f.usage, 0, 10);
    const past = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(f.usage, past, past);
    await f.pull();
    expect(fs.statSync(f.usage).mtimeMs).toBe(past.getTime());
    expect(lines(f.usage)).toHaveLength(10);
  }, 60_000);

  it('caps a reporting scope whose push is rejected and reports its newest events on retry', async () => {
    const f = fixture('claude', 'git');
    await f.pull(); // Warm reports worktree without any session data.
    seedUsage(f.usage, 100, cap);
    f.receiver('reject');
    await f.pull();
    expect(lines(f.usage)).toEqual(Array(cap).fill(expect.stringContaining('"review"')));
    f.receiver('normal');
    await f.pull();
    expect(f.stats().skills.review.count).toBe(cap);
    expect(f.stats().skills.legacy).toBeUndefined();
    expect(lines(f.usage)).toEqual([]);
  }, 60_000);

  it('a reporting scope over the cap keeps every event written after the report read it', async () => {
    const f = fixture('claude', 'git');
    await f.pull(); // Warm reports worktree without any session data.
    seedUsage(f.usage, 100, cap);
    f.receiver('slow');
    await f.pull(() => fs.appendFileSync(f.usage, line('late') + '\n' + line('late') + '\n'));
    expect(lines(f.usage)).toEqual([expect.stringContaining('"late"'), expect.stringContaining('"late"')]);
    // #1056: `legacy` is not in the team's shared catalog, so the privacy filter keeps it
    // out of the published stats; the events read before the append still reported `review`.
    expect(f.stats().skills.legacy).toBeUndefined();
    expect(f.stats().skills.review.count).toBe(cap);
  }, 60_000);
});
