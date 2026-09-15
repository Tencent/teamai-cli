import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'dist/index.js');
const agents = { claude: '.claude', codex: '.codex', codebuddy: '.codebuddy', opencode: '.config/opencode' };
let sandbox: string;

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
}

function fixture(agent: keyof typeof agents, provider: string) {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-report-timeout-'));
  const home = path.join(sandbox, 'home');
  const seed = path.join(sandbox, 'seed');
  const remote = path.join(sandbox, 'remote.git');
  const clone = path.join(home, '.teamai/team-repo');
  fs.mkdirSync(seed, { recursive: true });
  fs.mkdirSync(path.join(home, agents[agent]), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Report Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Report Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', FORCE_COLOR: '0' };
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: 'report-test', repo: remote, provider }));
  git(['init', '-q', '-b', 'main'], seed, env);
  git(['add', '.'], seed, env);
  git(['commit', '-q', '-m', 'fixture'], seed, env);
  git(['clone', '-q', '--bare', seed, remote], sandbox, env);
  git(['clone', '-q', remote, clone], sandbox, env);
  fs.writeFileSync(path.join(home, '.teamai/config.yaml'), YAML.stringify({
    repo: { localPath: clone, remote, kind: 'git' }, username: 'alice', scope: 'user',
    updatePolicy: 'skip', enabledAgents: [agent], additionalRoles: [],
  }));
  const usage = path.join(home, '.teamai/usage.jsonl');
  const dashboard = path.join(home, '.teamai/dashboard');
  const timestamp = new Date().toISOString();
  const usageLine = JSON.stringify({ skill: 'review', tool: agent, timestamp }) + '\n';
  function seedEvents() {
    fs.mkdirSync(dashboard, { recursive: true });
    fs.writeFileSync(usage, usageLine);
    fs.writeFileSync(path.join(dashboard, 'events.jsonl'), [
      { type: 'session_start', timestamp, sessionId: 's1', tool: agent, cwd: sandbox },
      { type: 'prompt_submit', timestamp, sessionId: 's1', tool: agent, promptSummary: 'review' },
      { type: 'stop', timestamp, sessionId: 's1', tool: agent, interventions: { interrupt: 1, toolReject: 0 },
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  function receiver(mode: 'slow' | 'reject' | 'normal') {
    fs.writeFileSync(path.join(remote, 'hooks/update'), `#!/bin/sh\nif [ "$1" = "refs/heads/teamai-reports" ]; then\n  ${mode === 'slow' ? 'sleep 7' : mode === 'reject' ? 'exit 1' : ':'}\nfi\nexit 0\n`, { mode: 0o755 });
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
  return { home, usage, usageLine, dashboard, seedEvents, receiver, pull, stats };
}

afterEach(() => {
  if (sandbox && path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('teamai-report-timeout-')) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('real CLI report completion', () => {
  for (const provider of ['git', 'gitlab', 'github']) {
    for (const agent of Object.keys(agents) as Array<keyof typeof agents>) {
      it(`acknowledges slow pushes once: ${provider}/${agent}`, async () => {
        const f = fixture(agent, provider);
        await f.pull(); // Warm reports worktree without any session data.
        f.seedEvents();
        f.receiver('slow');
        const output = await f.pull(() => {
          expect(fs.readFileSync(f.usage, 'utf8')).toBe(f.usageLine);
          expect(fs.existsSync(path.join(f.dashboard, 'reported-prompt-tokens.json'))).toBe(false);
          expect(fs.existsSync(path.join(f.home, '.teamai/.sync-lock'))).toBe(true);
          // An event arriving during the push must survive cleanup of the batch.
          fs.appendFileSync(f.usage, f.usageLine);
        });
        expect(output).toContain('Auto-report is still running after 5s');
        expect(f.stats().skills.review.count).toBe(1);
        expect(fs.readFileSync(f.usage, 'utf8')).toBe(f.usageLine);
        for (const name of ['interventions', 'prompt-tokens', 'daily-sessions']) {
          expect(JSON.parse(fs.readFileSync(path.join(f.dashboard, `reported-${name}.json`), 'utf8')).s1).toBeDefined();
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
    f.seedEvents();
    f.receiver('reject');
    await f.pull();
    expect(fs.readFileSync(f.usage, 'utf8')).toBe(f.usageLine);
    expect(fs.existsSync(path.join(f.dashboard, 'reported-prompt-tokens.json'))).toBe(false);
    f.receiver('normal');
    await f.pull();
    const stats = f.stats();
    expect(stats.skills.review.count).toBe(1);
    expect(stats.prompts).toBe(1);
    expect(stats.tokens.input).toBe(10);
    expect(fs.readFileSync(f.usage, 'utf8')).toBe('');
  }, 60_000);
});
