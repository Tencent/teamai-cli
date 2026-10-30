/**
 * E2E: a fresh `init --http --scope user` with a token and no --agent succeeds.
 * That init writes the apikey and the http config.yaml before it sets up the
 * local agent, and loading the local-agent config backfills a config.json from
 * them; the backfill is the init's own footprint and must not read as an
 * install the setup refuses. Exit 0, no refusal, and the agent reports with
 * the token the init saved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';
import { startMockServer, type MockServerHandle } from '../helpers/mock-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const API_KEY = 'e2e-fresh-init-key';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
let server: MockServerHandle;

beforeAll(async () => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fresh-http-init-')));
  server = await startMockServer({ apiKey: API_KEY });
});

afterAll(async () => {
  await waitForDetachedChildren();
  await server?.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('init --http --scope user on a fresh machine', () => {
  it('succeeds with a token and no --agent, and the agent reports with that token', async () => {
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1', SHELL: '/bin/bash', FORCE_COLOR: '0',
    };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.TEAMAI_API_TOKEN;
    delete env.TEAMAI_API_KEY;
    const git = (args: string[], cwd: string): { code: number | null; out: string } => {
      const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const run = (args: string[], cwd: string, input?: string): Promise<Run> => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      child.on('close', (code) => resolve({ code, output }));
      child.stdin.end(input ?? '');
    });

    const init = await run(['init', '--http', server.url, '--token', API_KEY, '--scope', 'user'], home);

    expect(init.code, init.output).toBe(0);
    expect(init.output).not.toContain('already initialized');
    expect(init.output).not.toContain('without the local agent');
    const config = JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'local-agent', 'config.json'), 'utf8'));
    expect(config.endpoint).toBe(server.url);
    expect(config.token).toBe(API_KEY);

    // The agent works: an enrolled workspace's session start reports with the token.
    const ws = path.join(sandbox, 'ws');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'README.md'), '# ws\n');
    expect(git(['init', '-q', '-b', 'main'], ws).code).toBe(0);
    git(['add', '-A'], ws);
    git(['commit', '-q', '-m', 'ws'], ws);
    const enroll = await run(['bind-project', '--skip'], ws);
    expect(enroll.code, enroll.output).toBe(0);
    const reportsBefore = server.reports.length;
    const session = await run(['hook-dispatch', 'session-start', '--tool', 'claude'], ws, JSON.stringify({
      cwd: ws, session_id: 's-fresh-init', hook_event_name: 'SessionStart', source: 'startup',
    }));
    await waitForDetachedChildren();
    expect(session.code, session.output).toBe(0);
    expect(server.reports.length).toBeGreaterThan(reportsBefore);
  }, 120_000);
});
